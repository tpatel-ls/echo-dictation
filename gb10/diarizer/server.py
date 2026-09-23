"""
Speaker diarization for Echo's meeting transcripts, served in-process with pyannote.audio 4.

  Echo -> auth shim (Bearer key, POST /v1/audio/diarizations) -> THIS server (127.0.0.1:8004)

Runs pyannote/speaker-diarization-community-1 (CC-BY-4.0) from a local copy, so it needs neither
the network nor a Hugging Face token at runtime. Binds to loopback and has no auth of its own: the
shim in front of it owns authentication.

Stateless by design: audio, turns, and embeddings are never written to disk or logged; the log
carries durations and timings only. Each response has one unit-length centroid embedding per
speaker; Echo matches those against its own local voiceprints, so names never leave the user's PC.
"""
import asyncio
import io
import logging
import os
import time

os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")  # pyannote 4 telemetry defaults to on

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from pyannote.audio import Pipeline

MODEL_DIR = os.environ.get("DIAR_MODEL", os.path.expanduser("~/diar/models/speaker-diarization-community-1"))
MODEL_ID = "pyannote/speaker-diarization-community-1"
EMBEDDING_ID = "pyannote/wespeaker-voxceleb-resnet34-LM"
EMBEDDING_DIM = 256
BATCH = int(os.environ.get("DIAR_BATCH", "32"))
SAMPLE_RATE = 16_000
MIN_EMBED_SPEECH_S = 3.0  # a centroid built from less speech is too noisy to match against a voiceprint
MAX_SPEAKERS = 20

log = logging.getLogger("diarizer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

if not os.path.isfile(os.path.join(MODEL_DIR, "config.yaml")):
    raise SystemExit(f"no pipeline at {MODEL_DIR}: download {MODEL_ID} there first (see docs/gb10-asr-upgrade.md)")

pipeline = Pipeline.from_pretrained(MODEL_DIR)
pipeline.to(torch.device("cuda"))
# The constructor defaults are 1; batching is what makes an hour take a minute, not ten.
pipeline.segmentation_batch_size = BATCH
pipeline.embedding_batch_size = BATCH

# One GPU stream: requests queue here instead of contending inside CUDA.
gpu_lock = asyncio.Lock()


def _diarize(audio: np.ndarray, num: int | None, low: int | None, high: int | None) -> dict:
    waveform = torch.from_numpy(audio).unsqueeze(0)  # (channel, time): no torchcodec/ffmpeg decode
    with torch.inference_mode():
        out = pipeline(
            {"waveform": waveform, "sample_rate": SAMPLE_RATE},
            num_speakers=num, min_speakers=low, max_speakers=high,
        )
    exclusive = out.exclusive_speaker_diarization
    segments = sorted(
        (
            {"start": round(turn.start, 3), "end": round(turn.end, 3), "speaker": label}
            for turn, _, label in exclusive.itertracks(yield_label=True)
        ),
        key=lambda s: (s["start"], s["end"]),
    )
    labels = out.speaker_diarization.labels()  # speaker_embeddings rows follow this order
    centroids = out.speaker_embeddings if out.speaker_embeddings is not None else np.zeros((0, EMBEDDING_DIM))
    speakers = []
    for i, label in enumerate(labels):
        speech = float(exclusive.label_duration(label))
        vector = np.asarray(centroids[i], dtype=np.float64) if i < len(centroids) else None
        norm = float(np.linalg.norm(vector)) if vector is not None and vector.size else 0.0
        # pyannote pads missing centroids with zeros; a short speaker's centroid is noise.
        usable = np.isfinite(norm) and norm > 0 and speech >= MIN_EMBED_SPEECH_S
        speakers.append({
            "id": label,
            "speech_seconds": round(speech, 2),
            "turns": len(exclusive.label_timeline(label)),
            "embedding": [round(float(x), 6) for x in vector / norm] if usable else None,
        })
    dim = int(centroids.shape[1]) if centroids.ndim == 2 and centroids.shape[1] else EMBEDDING_DIM
    return {"embedding_dim": dim, "segments": segments, "speakers": speakers}


def _warm() -> None:
    rng = np.random.default_rng(0)
    _diarize((rng.standard_normal(SAMPLE_RATE * 10) * 0.01).astype(np.float32), None, None, None)


started = time.perf_counter()
_warm()
log.info("loaded %s (batch %d) and warmed in %.1fs", MODEL_ID, BATCH, time.perf_counter() - started)

app = FastAPI(title="GB10 Diarizer", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_ID,
        "embedding_model": EMBEDDING_ID,
        "batch": BATCH,
        "memory_mb": round(torch.cuda.memory_allocated() / 2**20),
        "max_memory_mb": round(torch.cuda.max_memory_allocated() / 2**20),
    }


@app.post("/v1/audio/diarizations")
async def diarizations(
    file: UploadFile = File(...),
    num_speakers: int | None = Form(None),
    min_speakers: int | None = Form(None),
    max_speakers: int | None = Form(None),
    embeddings: bool = Form(True),
):
    for name, value in (("num_speakers", num_speakers), ("min_speakers", min_speakers), ("max_speakers", max_speakers)):
        if value is not None and not 1 <= value <= MAX_SPEAKERS:
            return _error(f"{name} must be between 1 and {MAX_SPEAKERS}")
    if min_speakers is not None and max_speakers is not None and min_speakers > max_speakers:
        return _error("min_speakers is larger than max_speakers")

    raw = await file.read()
    try:
        audio, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as exc:  # soundfile raises several unrelated types
        return _error(f"could not decode audio: {exc}")
    if rate != SAMPLE_RATE:
        return _error(f"expected {SAMPLE_RATE} Hz audio, got {rate} Hz")
    audio = audio.mean(axis=1) if audio.shape[1] > 1 else audio[:, 0]

    started = time.perf_counter()
    result = {"embedding_dim": EMBEDDING_DIM, "segments": [], "speakers": []}
    if audio.size >= SAMPLE_RATE // 2:  # under 500 ms there is nothing to diarize
        async with gpu_lock:
            waited = time.perf_counter() - started
            result = await asyncio.to_thread(
                _diarize, np.ascontiguousarray(audio), num_speakers, min_speakers, max_speakers
            )
    else:
        waited = 0.0
    elapsed = time.perf_counter() - started
    log.info(
        "diarized %.1fs audio into %d speakers in %.0f ms (%.0f ms queued)",
        audio.size / SAMPLE_RATE, len(result["speakers"]), elapsed * 1000, waited * 1000,
    )

    if not embeddings:
        for speaker in result["speakers"]:
            speaker["embedding"] = None
    return JSONResponse({
        "duration": round(audio.size / SAMPLE_RATE, 3),
        "model": MODEL_ID,
        "embedding_model": EMBEDDING_ID,
        **result,
    })


def _error(message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": "invalid_request_error"}}, status_code=400)
