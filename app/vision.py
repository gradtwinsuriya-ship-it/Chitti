from __future__ import annotations

import base64
import io
import threading
from importlib.util import find_spec

import httpx


MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
IMAGE_SIGNATURES = {
    "image/jpeg": lambda image: image.startswith(b"\xff\xd8\xff"),
    "image/png": lambda image: image.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/webp": lambda image: len(image) >= 12 and image.startswith(b"RIFF") and image[8:12] == b"WEBP",
}


class VisionService:
    def __init__(
        self,
        yolo_model: str = "yolo11n.pt",
        caption_base_url: str = "",
        caption_model: str = "",
        caption_api_key: str = "",
        timeout_seconds: float = 60.0,
    ) -> None:
        self.yolo_model = yolo_model
        self.caption_base_url = caption_base_url.rstrip("/")
        self.caption_model = caption_model.strip()
        self.caption_api_key = caption_api_key
        self.timeout_seconds = timeout_seconds
        self._detector = None
        self._detector_lock = threading.Lock()

    def status(self) -> dict[str, object]:
        return {
            "object_detection": {
                "engine": "YOLO",
                "installed": find_spec("ultralytics") is not None,
                "model": self.yolo_model,
            },
            "ocr": {
                "engine": "Tesseract",
                "installed": find_spec("pytesseract") is not None,
                "requires_system_binary": True,
            },
            "scene_description": {
                "enabled": bool(self.caption_base_url and self.caption_model),
                "model": self.caption_model or None,
            },
            "face_recognition": {
                "enabled": False,
                "reason": "Consent-based encrypted enrollment is not implemented.",
            },
            "maximum_image_bytes": MAX_IMAGE_BYTES,
            "maximum_image_pixels": MAX_IMAGE_PIXELS,
            "images_persisted": False,
        }

    def validate_image(self, image: bytes, content_type: str) -> tuple[int, int]:
        if not image:
            raise ValueError("No image was received.")
        if len(image) > MAX_IMAGE_BYTES:
            raise ValueError("Image exceeds the 12 MB limit.")
        content_type = content_type.split(";", 1)[0].strip().lower()
        if content_type not in SUPPORTED_IMAGE_TYPES:
            raise ValueError("Use JPEG, PNG, or WebP images.")
        if not IMAGE_SIGNATURES[content_type](image):
            raise ValueError("Image bytes do not match the declared image format.")
        try:
            from PIL import Image

            with Image.open(io.BytesIO(image)) as source:
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise ValueError("Image dimensions exceed the 20 megapixel limit.")
                source.verify()
        except ImportError:
            raise RuntimeError("Install requirements-vision.txt to decode images safely.")
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError("Image could not be decoded.") from exc
        return width, height

    def analyze(
        self,
        image: bytes,
        content_type: str,
        include_ocr: bool = False,
        include_description: bool = False,
        ocr_language: str = "eng",
    ) -> dict[str, object]:
        width, height = self.validate_image(image, content_type)
        warnings = []
        objects = []
        text = None
        description = None
        try:
            objects = self._detect_objects(image)
        except (ImportError, RuntimeError) as exc:
            warnings.append(str(exc))
        if include_ocr:
            try:
                text = self._extract_text(image, ocr_language)
            except (ImportError, RuntimeError) as exc:
                warnings.append(str(exc))
        if include_description:
            try:
                description = self._describe_scene(image, content_type)
            except (RuntimeError, httpx.HTTPError) as exc:
                warnings.append(str(exc))
        return {
            "width": width,
            "height": height,
            "objects": objects,
            "ocr_text": text,
            "scene_description": description,
            "warnings": warnings,
            "images_persisted": False,
        }

    def _detect_objects(self, image: bytes) -> list[dict[str, object]]:
        if self._detector is None:
            with self._detector_lock:
                if self._detector is None:
                    try:
                        from ultralytics import YOLO
                    except ImportError as exc:
                        raise RuntimeError("Install requirements-vision.txt to enable YOLO detection.") from exc
                    try:
                        self._detector = YOLO(self.yolo_model)
                    except Exception as exc:
                        raise RuntimeError("YOLO weights could not be loaded. Check the configured model and network.") from exc
        try:
            from PIL import Image

            with Image.open(io.BytesIO(image)) as source:
                results = self._detector(source.convert("RGB"), verbose=False)
            detections = []
            for result in results:
                for box in result.boxes:
                    class_id = int(box.cls[0].item())
                    detections.append(
                        {
                            "label": str(result.names[class_id]),
                            "confidence": round(float(box.conf[0].item()), 4),
                            "box_xyxy": [round(float(value), 1) for value in box.xyxy[0].tolist()],
                        }
                    )
                    if len(detections) >= 100:
                        return detections
            return detections
        except ImportError as exc:
            raise RuntimeError("Pillow is required for image analysis. Install requirements-vision.txt.") from exc
        except Exception as exc:
            raise RuntimeError("YOLO could not analyze this image.") from exc

    def _extract_text(self, image: bytes, language: str) -> str:
        if language not in {"eng", "tam", "hin"}:
            raise ValueError("OCR language must be English, Tamil, or Hindi.")
        try:
            import pytesseract
            from PIL import Image
        except ImportError as exc:
            raise RuntimeError("Install requirements-vision.txt to enable OCR.") from exc
        try:
            with Image.open(io.BytesIO(image)) as source:
                return pytesseract.image_to_string(source.convert("RGB"), lang=language)[:20_000].strip()
        except pytesseract.TesseractNotFoundError as exc:
            raise RuntimeError("Install the Tesseract system binary to enable OCR.") from exc
        except Exception as exc:
            raise RuntimeError("OCR could not analyze this image.") from exc

    def _describe_scene(self, image: bytes, content_type: str) -> str:
        if not self.caption_base_url or not self.caption_model:
            raise RuntimeError("Configure VISION_BASE_URL and VISION_MODEL for scene description.")
        headers = {"Content-Type": "application/json"}
        if self.caption_api_key:
            headers["Authorization"] = f"Bearer {self.caption_api_key}"
        encoded = base64.b64encode(image).decode("ascii")
        payload = {
            "model": self.caption_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Briefly describe visible objects and scene. Do not identify people."},
                        {"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{encoded}"}},
                    ],
                }
            ],
            "temperature": 0.2,
        }
        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                response = client.post(
                    f"{self.caption_base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                )
                response.raise_for_status()
                result = response.json()
            return str(result["choices"][0]["message"]["content"]).strip()[:4000]
        except httpx.HTTPError:
            raise
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("Vision model returned an unexpected response.") from exc