import base64
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
import torch
from app.infer_runtime import LoadedModel, UltralyticsRuntime, _guess_task_type
from app.schemas import Params
from app.task_adapters import adapt_result, dense_map, fuse_depth
from PIL import Image
from ultralytics.engine.results import Results


def result_for(task: str) -> Results:
    image = np.zeros((8, 12, 3), dtype=np.uint8)
    boxes = torch.tensor([[0, 0, 6, 8, 0.9, 0], [6, 0, 12, 8, 0.8, 1]])
    kwargs = {}
    if task in {"detect", "segment", "pose"}:
        kwargs["boxes"] = boxes
    if task == "segment":
        masks = torch.zeros((2, 8, 12))
        masks[0, :, :6] = 1
        masks[1, :, 6:] = 1
        kwargs["masks"] = masks
    if task == "pose":
        kwargs["keypoints"] = torch.tensor([[[1, 2, 0.9]], [[8, 3, 0.8]]])
    if task == "classify":
        kwargs["probs"] = torch.tensor([0.8, 0.2])
    if task == "obb":
        kwargs["obb"] = torch.tensor([[6, 4, 6, 2, 0.5, 0.9, 0]])
    if task == "semantic":
        kwargs["semantic_mask"] = torch.ones((8, 12), dtype=torch.uint8)
    if task == "depth":
        kwargs["depth"] = torch.full((8, 12), 2.5)
    return Results(image, path="fixture.jpg", names={0: "person", 1: "car"}, **kwargs)


def adapt(task, result=None, class_filter=None):
    return adapt_result(
        result or result_for(task),
        task=task,
        model_id="fixture.pt",
        names={"0": "person", "1": "car"},
        width=12,
        height=8,
        class_filter=class_filter or [],
        depth_min=0.1,
        depth_max=20,
    )


@pytest.mark.parametrize(
    "task,field",
    [
        ("detect", "bboxes"),
        ("segment", "masks"),
        ("pose", "keypoints"),
        ("classify", "classifications"),
        ("obb", "bboxes"),
        ("semantic", "semantic"),
        ("depth", "depth"),
    ],
)
def test_official_result_containers_preserve_every_task(task, field):
    pred, _ = adapt(task)
    assert pred.taskType == task
    assert getattr(pred, field)
    assert pred.schemaVersion == 2
    assert pred.modelId == "fixture.pt"
    if task == "obb":
        assert len(pred.bboxes[0].corners) == 4


def test_instance_filter_keeps_mask_and_pose_indices_aligned():
    segmented, kept = adapt("segment", class_filter=["car"])
    assert kept == [1]
    assert segmented.masks[0].cls == "car"
    assert min(p[0] for p in segmented.masks[0].points) >= 6
    posed, kept = adapt("pose", class_filter=["car"])
    assert kept == [1]
    assert posed.keypoints[0].points[0].x == 8


def test_classification_filter_ranks_selected_classes():
    pred, _ = adapt("classify", class_filter=["car"])
    assert [p.cls for p in pred.classifications] == ["car"]


def test_depth_binary_preserves_scale_and_invalid_pixels_with_fixed_preview_range():
    depth = np.array([[np.nan, np.inf, 0], [-1, 2.5, 150]], dtype=np.float32)
    output = dense_map(depth, task="depth", model_id="depth.pt", names={}, depth_min=0.1, depth_max=20)
    decoded = np.frombuffer(base64.b64decode(output.dataBase64), dtype="<f4").reshape(2, 3)
    np.testing.assert_equal(decoded, depth)
    assert output.min == 2.5 and output.max == 150
    assert output.validFraction == pytest.approx(2 / 6)
    assert output.colorMax == 20  # Color clipping must never clip exported values.
    png = cv2.imdecode(np.frombuffer(base64.b64decode(output.pngBase64), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    np.testing.assert_equal(png[..., 3], [[0, 0, 0], [0, 255, 255]])


def test_dense_transport_is_bounded_and_semantic_ids_are_not_colors():
    output = dense_map(
        np.full((720, 1280), 513),
        task="semantic",
        model_id="sem.pt",
        names={"513": "part"},
        depth_min=0.1,
        depth_max=20,
    )
    assert max(output.width, output.height) == 256
    assert len(base64.b64decode(output.dataBase64)) == output.width * output.height * 2
    assert set(np.frombuffer(base64.b64decode(output.dataBase64), dtype="<u2")) == {513}
    assert output.classes == {"513": "part"}


def test_fusion_uses_full_resolution_masks_and_ignores_invalid_pixels():
    result = result_for("segment")
    pred, kept = adapt("segment", result)
    depth = np.full((8, 12), 10, dtype=np.float32)
    depth[:, :6] = 2
    depth[0, 0] = np.nan
    fuse_depth(pred, result, kept, depth)
    assert [b.depthMeters for b in pred.bboxes] == [2, 10]
    assert pred.bboxes[0].depthMethod == "mask-median"
    assert pred.bboxes[0].depthValidFraction == pytest.approx(47 / 48)
    with pytest.raises(ValueError, match="coordinates"):
        fuse_depth(pred, result, kept, depth[:4])


def test_box_fusion_labels_approximation_and_reports_empty_regions():
    result = result_for("detect")
    pred, kept = adapt("detect", result)
    fuse_depth(pred, result, kept, np.zeros((8, 12), dtype=np.float32))
    assert pred.bboxes[0].depthMeters is None
    assert pred.bboxes[0].depthValidFraction == 0
    assert pred.bboxes[0].depthMethod == "box-center-median"


def test_unknown_tasks_fail_instead_of_silently_becoming_detection():
    with pytest.raises(ValueError, match="Unsupported model task"):
        _guess_task_type(SimpleNamespace(task="custom"))


def test_nms_free_capability_checks_branch_availability_not_current_mode():
    head = SimpleNamespace(end2end=False, one2one_cv2=object())
    fake = SimpleNamespace(model=SimpleNamespace(model=[head]))
    loaded = LoadedModel("model.pt", "model.pt", "detect", {}, "model.pt", fake)
    assert loaded.info().capabilities.nmsFree
    head.one2one_cv2 = None
    assert not loaded.info().capabilities.nmsFree


def test_runtime_converts_rgb_to_bgr_and_gates_tracking_for_dense_tasks(tmp_path):
    class Fake:
        def predict(self, image, **kwargs):
            assert image[0, 0].tolist() == [0, 0, 255]
            assert kwargs["nms"] is None
            return [result_for("depth")]

        def track(self, *args, **kwargs):
            pytest.fail("Depth must not enter a tracking predictor")

    runtime = UltralyticsRuntime(str(tmp_path))
    runtime._loaded = LoadedModel("depth.pt", "depth.pt", "depth", {}, "depth.pt", Fake())
    pred = runtime.infer_image(
        image=Image.new("RGB", (12, 8), "red"), device="cpu", conf=0.25, iou=0.7, class_filter=[], track=True
    )
    assert pred.depth.median == 2.5


def test_failed_model_load_preserves_previous_model(monkeypatch, tmp_path):
    runtime = UltralyticsRuntime(str(tmp_path))
    old = LoadedModel("old.pt", "old.pt", "detect", {}, "old.pt", object())
    runtime._loaded = old

    def fail(*args):
        raise RuntimeError("warmup failed")

    monkeypatch.setattr(runtime, "_create", fail)
    with pytest.raises(RuntimeError, match="warmup failed"):
        runtime.load("new.pt", "cpu")
    assert runtime.current() is old


def test_parameters_validate_input_size_and_depth_range():
    with pytest.raises(ValueError, match="multiple of 32"):
        Params(imgsz=641)
    with pytest.raises(ValueError, match="greater than"):
        Params(depthMin=20, depthMax=10)


@pytest.mark.parametrize("task", ["detect", "segment", "pose", "classify", "obb", "semantic", "depth"])
def test_rest_selection_and_inference_preserve_task_contract(monkeypatch, tmp_path, task):
    import io

    import app.main as main
    from app.state import AppState
    from fastapi.testclient import TestClient

    runtime = UltralyticsRuntime(str(tmp_path))
    fake = SimpleNamespace(predict=lambda *args, **kwargs: [result_for(task)])
    loaded = LoadedModel("fixture.pt", "fixture.pt", task, {"0": "person", "1": "car"}, "fixture.pt", fake)
    monkeypatch.setattr(runtime, "_create", lambda *args: loaded)
    monkeypatch.setattr(main, "runtime", runtime)
    monkeypatch.setattr(main, "state", AppState())
    image = io.BytesIO()
    Image.new("RGB", (12, 8), "red").save(image, format="PNG")
    client = TestClient(main.app)
    selected = client.post("/api/models/select", json={"modelId": "fixture.pt"})
    assert selected.status_code == 200
    assert selected.json()["taskType"] == task
    assert selected.json()["capabilities"]["tracking"] == (task in {"detect", "segment", "pose", "obb"})
    response = client.post("/api/infer/image", files={"file": ("fixture.png", image.getvalue(), "image/png")})
    assert response.status_code == 200
    output = response.json()
    assert output["taskType"] == task
    field = {
        "depth": "depth",
        "semantic": "semantic",
        "classify": "classifications",
        "segment": "masks",
        "pose": "keypoints",
    }.get(task, "bboxes")
    assert output[field]


def test_device_failure_and_wrong_auxiliary_task_preserve_state(monkeypatch, tmp_path):
    import app.main as main
    from app.state import AppState
    from fastapi.testclient import TestClient

    runtime = UltralyticsRuntime(str(tmp_path))
    previous = LoadedModel("depth.pt", "depth.pt", "depth", {}, "depth.pt", object())
    runtime._depth = previous
    wrong = LoadedModel("detect.pt", "detect.pt", "detect", {}, "detect.pt", object())
    monkeypatch.setattr(runtime, "_create", lambda *args: wrong)
    monkeypatch.setattr(main, "runtime", runtime)
    monkeypatch.setattr(main, "state", AppState())
    monkeypatch.setattr(main.torch.cuda, "is_available", lambda: False)
    client = TestClient(main.app)
    assert client.post("/api/engine/select", json={"device": "cuda"}).status_code == 400
    assert main.state.engine.device == "cpu"
    assert client.post("/api/models/depth", json={"modelId": "detect.pt"}).status_code == 400
    assert runtime.depth_model() is previous
    assert client.post("/api/models/depth", json={"modelId": None}).status_code == 200
    assert runtime.depth_model() is None
