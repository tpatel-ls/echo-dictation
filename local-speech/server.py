"""Local CPU/CUDA speech server. No cloud inference or private endpoints."""
import io
import json
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

MODEL = os.environ.get("ECHO_SPEECH_MODEL", "base.en")
DEVICE = os.environ.get("ECHO_SPEECH_DEVICE", "cpu")
COMPUTE = os.environ.get("ECHO_SPEECH_COMPUTE", "int8" if DEVICE == "cpu" else "float16")
MAX_BYTES = 64 * 1024 * 1024
engine = None
# One model call at a time avoids concurrent dictation/meeting requests exhausting memory.
inference_lock = threading.Lock()


def load_model():
    return WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE,
                        download_root=os.environ.get("ECHO_MODEL_CACHE", ".models"))


@asynccontextmanager
async def lifespan(_app):
    global engine
    engine = load_model()
    yield
    engine = None


app = FastAPI(title="Echo local speech", lifespan=lifespan)


def check_model(model: str):
    if model not in {"whisper-1", MODEL}:
        raise HTTPException(400, f"Model {model!r} is not loaded. Use whisper-1 or {MODEL}.")


def audio_of(file: UploadFile):
    payload = file.file.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES:
        raise HTTPException(413, "Audio exceeds 64 MiB; split it into smaller clips.")
    try:
        audio = decode_audio(io.BytesIO(payload), sampling_rate=16000)
    except Exception as error:
        raise HTTPException(400, "Could not decode the audio file.") from error
    if len(audio) == 0:
        raise HTTPException(400, "The audio file contains no samples.")
    return audio


def recognize(audio, prompt=None):
    if engine is None:
        raise HTTPException(503, "Speech model is still loading.")
    with inference_lock:
        segments, _info = engine.transcribe(
            audio, language="en", beam_size=5, temperature=0,
            vad_filter=True, condition_on_previous_text=False,
            initial_prompt=prompt or None,
        )
        return " ".join(s.text.strip() for s in segments).strip()


@app.get("/health")
def health():
    return {"status": "ready" if engine is not None else "loading", "model": MODEL, "device": DEVICE}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": "whisper-1", "object": "model", "owned_by": "local"}]}


@app.post("/v1/audio/transcriptions")
def transcriptions(file: UploadFile = File(...), model: str = Form("whisper-1"),
                   language: str = Form("en"), response_format: str = Form("json"),
                   prompt: str = Form("")):
    check_model(model)
    if language != "en" or response_format != "json":
        raise HTTPException(400, "This Echo server supports English and JSON responses.")
    return {"text": recognize(audio_of(file), prompt)}


@app.post("/v1/audio/segments")
def segments(file: UploadFile = File(...), segments: str = Form(...),
             models: str = Form("whisper-1"), prompt: str = Form("")):
    names = list(dict.fromkeys(m.strip() for m in models.split(",") if m.strip()))
    if not names:
        raise HTTPException(400, "At least one model is required.")
    for name in names:
        check_model(name)
    audio = audio_of(file)
    try:
        clips = json.loads(segments)
        if not isinstance(clips, list) or not 1 <= len(clips) <= 200:
            raise ValueError()
        ids = set()
        # Validate the whole request before running any inference.
        ranges = []
        for clip in clips:
            key = clip["id"]
            start, end = float(clip["start"]), float(clip["end"])
            if (not isinstance(key, str) or not key or key in ids
                    or not 0 <= start < end <= len(audio) / 16000 + 0.002):
                raise ValueError()
            ids.add(key)
            ranges.append((key, int(start * 16000), min(len(audio), round(end * 16000))))
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        raise HTTPException(400, "Invalid segment IDs or time ranges.") from error
    results = []
    for key, start, end in ranges:
        text = recognize(audio[start:end], prompt)
        results.append({"id": key, "texts": {name: text for name in names}})
    return {"results": results}


# No diarization route: Echo handles 404 by labelling the two captured channels.
# Multiple remote speakers require a separately configured diarization service.
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("ECHO_SPEECH_PORT", "8178")),
                access_log=False)
