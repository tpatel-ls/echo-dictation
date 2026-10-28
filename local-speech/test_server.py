import io
import json
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
import server


def wav():
    stream = io.BytesIO()
    with wave.open(stream, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b"\0\0" * 16000)
    return stream.getvalue()


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)
        self.files = {"file": ("audio.wav", wav(), "audio/wav")}

    def test_standard_audio_route_decodes_without_auth(self):
        model = SimpleNamespace(transcribe=lambda audio, **kw: ([SimpleNamespace(text=" Local words. ")], None))
        with patch.object(server, "engine", model):
            res = self.client.post("/v1/audio/transcriptions", files=self.files, data={"model": "whisper-1"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"text": "Local words."})

    def test_meeting_segments_keep_ids_models_and_clip_boundaries(self):
        seen = []
        def decode(audio, **kwargs):
            seen.append((len(audio), kwargs["initial_prompt"]))
            return [SimpleNamespace(text="Meeting words.")], None
        with patch.object(server, "engine", SimpleNamespace(transcribe=decode)):
            res = self.client.post("/v1/audio/segments", files=self.files, data={
                "models": "whisper-1", "prompt": "Sample Name",
                "segments": json.dumps([{"id": "s1", "start": 0.25, "end": 0.75}])})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"results": [{"id": "s1", "texts": {"whisper-1": "Meeting words."}}]})
        self.assertEqual(seen, [(8000, "Sample Name")])

    def test_bad_upload_model_and_ranges_are_rejected(self):
        res = self.client.post("/v1/audio/transcriptions", files={"file": ("broken.wav", b"broken")})
        self.assertEqual(res.status_code, 400)
        res = self.client.post("/v1/audio/transcriptions", files=self.files, data={"model": "not-installed"})
        self.assertEqual(res.status_code, 400)
        for clips in [[], [{"id": "s1", "start": -1, "end": 1}], [{"id": "s1", "start": 0, "end": 5}],
                      [{"id": "s1", "start": 0, "end": 1}] * 2]:
            res = self.client.post("/v1/audio/segments", files=self.files, data={"segments": json.dumps(clips)})
            self.assertEqual(res.status_code, 400)

    def test_diarization_is_optional_and_loading_is_explicit(self):
        self.assertEqual(self.client.post("/v1/audio/diarizations", files=self.files).status_code, 404)
        with patch.object(server, "engine", None):
            res = self.client.post("/v1/audio/transcriptions", files=self.files)
            self.assertEqual(res.status_code, 503)


if __name__ == "__main__":
    unittest.main()
