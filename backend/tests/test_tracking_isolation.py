import app.infer_runtime as infer_runtime
import pytest
from app.infer_runtime import LoadedModel, UltralyticsRuntime


class FakeYolo:
    def __init__(self, path: str) -> None:
        self.path = path


def test_tracking_contexts_are_isolated_and_released(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(infer_runtime, "YOLO", FakeYolo)
    runtime = UltralyticsRuntime(str(tmp_path), max_tracker_contexts=2)
    loaded = LoadedModel(
        id="model.pt", filename="model.pt", task_type="detect", names={}, path=str(tmp_path / "model.pt"), yolo=FakeYolo("main")
    )
    runtime._loaded = loaded

    first = runtime._tracking_model(loaded, "camera-1")
    second = runtime._tracking_model(loaded, "camera-2")
    assert first is not second
    assert runtime._tracking_model(loaded, "camera-1") is first
    with pytest.raises(RuntimeError):
        runtime._tracking_model(loaded, "camera-3")

    runtime.release_tracker("camera-1")
    assert runtime._tracking_model(loaded, "camera-3") is not first
