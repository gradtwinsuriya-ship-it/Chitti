import sys
from types import ModuleType, SimpleNamespace

import pytest

from app.vision import MAX_IMAGE_BYTES, VisionService


TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082"
)


class FakeVisionService(VisionService):
    def _detect_objects(self, image):
        return [{"label": "cup", "confidence": 0.97, "box_xyxy": [1.0, 2.0, 10.0, 12.0]}]

    def _extract_text(self, image, language):
        return f"CHITTI ({language})"

    def _describe_scene(self, image, content_type):
        return "A cup on a table."


def test_vision_validates_supported_image_and_returns_requested_analysis(monkeypatch) -> None:
    class FakeImage:
        size = (1, 1)

        def __enter__(self):
            return self

        def __exit__(self, exception_type, exception, traceback):
            return False

        def verify(self):
            return None

    pillow = ModuleType("PIL")
    pillow.Image = SimpleNamespace(open=lambda image: FakeImage())
    monkeypatch.setitem(sys.modules, "PIL", pillow)
    result = FakeVisionService().analyze(
        TINY_PNG,
        "image/png",
        include_ocr=True,
        include_description=True,
        ocr_language="tam",
    )

    assert result["width"] == 1
    assert result["height"] == 1
    assert result["objects"][0]["label"] == "cup"
    assert result["ocr_text"] == "CHITTI (tam)"
    assert result["scene_description"] == "A cup on a table."
    assert result["images_persisted"] is False


@pytest.mark.parametrize(
    ("image", "content_type", "message"),
    [
        (b"", "image/png", "No image"),
        (b"not png", "image/png", "do not match"),
        (TINY_PNG, "text/plain", "Use JPEG"),
        (TINY_PNG + b"0" * MAX_IMAGE_BYTES, "image/png", "12 MB limit"),
    ],
)
def test_vision_rejects_invalid_images(image, content_type, message) -> None:
    with pytest.raises(ValueError, match=message):
        VisionService().validate_image(image, content_type)


def test_status_keeps_biometric_recognition_disabled() -> None:
    status = VisionService().status()

    assert status["face_recognition"]["enabled"] is False
    assert status["images_persisted"] is False


def test_vision_rejects_images_over_pixel_limit(monkeypatch) -> None:
    class OversizedImage:
        size = (5000, 5000)

        def __enter__(self):
            return self

        def __exit__(self, exception_type, exception, traceback):
            return False

    pillow = ModuleType("PIL")
    pillow.Image = SimpleNamespace(open=lambda image: OversizedImage())
    monkeypatch.setitem(sys.modules, "PIL", pillow)

    with pytest.raises(ValueError, match="20 megapixel"):
        VisionService().validate_image(TINY_PNG, "image/png")