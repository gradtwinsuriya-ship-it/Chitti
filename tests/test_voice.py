from types import SimpleNamespace

import pytest

from app.voice import LocalWhisperTranscriber


class FakeWhisperModel:
    def __init__(self):
        self.options = None

    def transcribe(self, path, **options):
        self.options = options
        with open(path, "rb") as audio_file:
            assert audio_file.read() == b"sample-audio"
        return iter([SimpleNamespace(text=" Vanakkam "), SimpleNamespace(text=" Chitti ")]), SimpleNamespace(
            language="ta", language_probability=0.96, duration=1.2
        )


def test_transcriber_returns_multilingual_text_and_uses_selected_language() -> None:
    transcriber = LocalWhisperTranscriber()
    model = FakeWhisperModel()
    transcriber._model = model

    result = transcriber.transcribe(b"sample-audio", language="ta", content_type="audio/webm; codecs=opus")

    assert result["text"] == "Vanakkam Chitti"
    assert result["language"] == "ta"
    assert model.options == {"language": "ta", "beam_size": 1, "vad_filter": True}


@pytest.mark.parametrize(
    ("audio", "language", "content_type", "message"),
    [
        (b"", "auto", "audio/webm", "No audio"),
        (b"voice", "fr", "audio/webm", "Choose automatic"),
        (b"voice", "auto", "application/octet-stream", "Use WebM"),
    ],
)
def test_transcriber_rejects_invalid_input(audio, language, content_type, message) -> None:
    with pytest.raises(ValueError, match=message):
        LocalWhisperTranscriber().transcribe(audio, language, content_type)