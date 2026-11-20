from __future__ import annotations

import tempfile
import threading
from pathlib import Path


SUPPORTED_AUDIO_TYPES = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".mp4",
    "audio/mpeg": ".mp3",
}
MAX_AUDIO_BYTES = 25 * 1024 * 1024


class LocalWhisperTranscriber:
    def __init__(
        self,
        model_size: str = "base",
        device: str = "cpu",
        compute_type: str = "int8",
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._model_lock = threading.Lock()

    def _get_model(self):
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is None:
                try:
                    from faster_whisper import WhisperModel
                except ImportError as exc:
                    raise RuntimeError(
                        "Voice transcription is not installed. Install requirements-voice.txt."
                    ) from exc
                self._model = WhisperModel(
                    self.model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                )
        return self._model

    def transcribe(self, audio: bytes, language: str = "auto", content_type: str = "audio/webm") -> dict[str, object]:
        if not audio:
            raise ValueError("No audio was received.")
        if len(audio) > MAX_AUDIO_BYTES:
            raise ValueError("Audio exceeds the 25 MB limit.")
        extension = SUPPORTED_AUDIO_TYPES.get(content_type.split(";", 1)[0].strip().lower())
        if extension is None:
            raise ValueError("Use WebM, Ogg, WAV, MP4, or MP3 audio.")
        if language not in {"auto", "en", "ta", "hi"}:
            raise ValueError("Choose automatic detection, English, Tamil, or Hindi.")

        with tempfile.TemporaryDirectory(prefix="chitti-audio-") as directory:
            audio_path = Path(directory) / f"recording{extension}"
            audio_path.write_bytes(audio)
            try:
                segments, info = self._get_model().transcribe(
                    str(audio_path),
                    language=None if language == "auto" else language,
                    beam_size=1,
                    vad_filter=True,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()
            except Exception as exc:
                if isinstance(exc, RuntimeError):
                    raise
                raise RuntimeError("Local transcription failed for this audio format.") from exc
        return {
            "text": text,
            "language": getattr(info, "language", language),
            "language_probability": getattr(info, "language_probability", None),
            "duration_seconds": getattr(info, "duration", None),
            "engine": "faster-whisper",
            "model": self.model_size,
        }