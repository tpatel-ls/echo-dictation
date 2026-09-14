"""
Parakeet TDT speech recognizer for Echo, served in-process with NVIDIA NeMo.

  Echo -> auth shim (Bearer key, routes `model=parakeet*`) -> THIS server (127.0.0.1:8002)

Exposes the same OpenAI-compatible POST /v1/audio/transcriptions contract as the Whisper route,
so switching recognizers is only a model-name change in Echo. Binds to loopback and has no auth of
its own: the shim in front of it owns authentication.

Parakeet is non-autoregressive: decoding is greedy and deterministic, so `temperature` and
`prompt` are accepted for compatibility and ignored. Echo's dictionary still applies client-side.
"""
import asyncio
import io
import logging
import os
import time

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

import nemo.collections.asr as nemo_asr

MODEL_ID = os.environ.get("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v2")
PRECISION = os.environ.get("PARAKEET_PRECISION", "bf16")  # bf16 | fp32
SAMPLE_RATE = 16_000

log = logging.getLogger("parakeet")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

model = nemo_asr.models.ASRModel.from_pretrained(MODEL_ID, map_location="cuda")
model.eval()
# Inference must be repeatable: no dither noise, no padding to a fixed multiple.
model.preprocessor.featurizer.dither = 0.0
model.preprocessor.featurizer.pad_to = 0

# One GPU stream: requests queue here instead of contending inside CUDA.
gpu_lock = asyncio.Lock()


def _decode(audio: np.ndarray) -> str:
    autocast = torch.autocast("cuda", dtype=torch.bfloat16, enabled=PRECISION == "bf16")
    with torch.inference_mode(), autocast:
        out = model.transcribe([audio], batch_size=1, verbose=False)
    if isinstance(out, tuple):  # older RNNT API returns (best, all)
        out = out[0]
    first = out[0] if out else ""
    if isinstance(first, list):
        first = first[0] if first else ""
    return (getattr(first, "text", first) or "").strip()


def _warm() -> None:
    rng = np.random.default_rng(0)
    for seconds in (1, 5, 15):
        _decode((rng.standard_normal(SAMPLE_RATE * seconds) * 0.01).astype(np.float32))


started = time.perf_counter()
_warm()
log.info("loaded %s (%s) and warmed in %.1fs", MODEL_ID, PRECISION, time.perf_counter() - started)

app = FastAPI(title="GB10 Parakeet", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "precision": PRECISION}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model_name: str = Form("parakeet", alias="model"),
    response_format: str = Form("json"),
    language: str | None = Form(None),
    temperature: float = Form(0.0),
    prompt: str | None = Form(None),
):
    raw = await file.read()
    try:
        audio, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as exc:  # soundfile raises several unrelated types
        return _error(f"could not decode audio: {exc}")
    if rate != SAMPLE_RATE:
        return _error(f"expected {SAMPLE_RATE} Hz audio, got {rate} Hz")
    audio = audio.mean(axis=1) if audio.shape[1] > 1 else audio[:, 0]

    started = time.perf_counter()
    text = ""
    if audio.size >= SAMPLE_RATE // 10:  # under 100 ms is not speech
        async with gpu_lock:
            text = await asyncio.to_thread(_decode, np.ascontiguousarray(audio))
    log.info("decoded %.2fs audio in %.0f ms", audio.size / SAMPLE_RATE, (time.perf_counter() - started) * 1000)

    if response_format == "text":
        return PlainTextResponse(text + "\n")
    return JSONResponse({"text": text})


def _error(message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": "invalid_request_error"}}, status_code=400)
