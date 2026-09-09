import struct

from app.main import _pack_stream_frame, _redacted_stream_url


def test_rtsp_credentials_are_redacted() -> None:
    assert _redacted_stream_url("rtsp://user:secret@camera.local:8554/live?token=x") == "rtsp://camera.local:8554"


def test_binary_frame_packet_has_bounded_header() -> None:
    packet = _pack_stream_frame(stream_id="cam", frame_id="1", ts=2.0, width=10, height=20, jpeg=b"jpeg")
    header_size = struct.unpack("!I", packet[:4])[0]
    assert 0 < header_size < len(packet)
    assert packet[4 + header_size :] == b"jpeg"
