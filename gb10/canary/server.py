"""
Canary-Qwen 2.5B speech recognizer for Echo, served in-process with NVIDIA NeMo (SALM).

  Echo -> auth shim (Bearer key, routes `model=canary*`) -> THIS server (127.0.0.1:8003)

Same OpenAI-compatible POST /v1/audio/transcriptions contract as the other GB10 routes. Canary-Qwen
pairs a FastConformer encoder with a Qwen3 LLM decoder, which gives it a much stronger language
prior than Parakeet ("mic testing", names, numbers) at a higher per-request cost. Echo uses it as
an independent cross-check next to Parakeet and Whisper.

Decoding is greedy, so `temperature` and `prompt` are accepted for compatibility and ignored.
The model was trained on clips up to 40 s; longer audio is split at the quietest point near each
boundary and the pieces are decoded as one batch.
"""
import asyncio
import io
import logging
import os
import re
import time

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

from nemo.collections.speechlm2.models import SALM

MODEL_ID = os.environ.get("CANARY_MODEL", "nvidia/canary-qwen-2.5b")
SAMPLE_RATE = 16_000
MAX_CHUNK_S = 35
MIN_CHUNK_S = 20

log = logging.getLogger("canary")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

model = SALM.from_pretrained(MODEL_ID).bfloat16().eval().to("cuda")
PROMPT = f"Transcribe the following: {model.audio_locator_tag}"
SPECIAL_TOKENS = re.compile(r"<\|[^|>]*\|>|<think>.*?</think>", re.S)

gpu_lock = asyncio.Lock()


def _chunks(audio: np.ndarray) -> list[np.ndarray]:
    """Split long audio at the quietest 100 ms frame between MIN_CHUNK_S and MAX_CHUNK_S."""
    pieces, start, hop = [], 0, SAMPLE_RATE // 10
    while audio.size - start > MAX_CHUNK_S * SAMPLE_RATE:
        lo, hi = start + MIN_CHUNK_S * SAMPLE_RATE, start + MAX_CHUNK_S * SAMPLE_RATE
        frames = audio[lo:hi][: (hi - lo) // hop * hop].reshape(-1, hop)
        cut = lo + int(np.argmin((frames**2).mean(axis=1))) * hop + hop // 2
        pieces.append(audio[start:cut])
        start = cut
    pieces.append(audio[start:])
    return pieces


def _decode(audio: np.ndarray) -> str:
    pieces = _chunks(audio)
    lens = torch.tensor([p.size for p in pieces], dtype=torch.int64, device="cuda")
    batch = torch.zeros(len(pieces), int(lens.max()), dtype=torch.float32, device="cuda")
    for i, piece in enumerate(pieces):
        batch[i, : piece.size] = torch.from_numpy(piece).to("cuda")
    max_new_tokens = int(48 + (audio.size / SAMPLE_RATE / len(pieces)) * 10)
    with torch.inference_mode():
        ids = model.generate(
            prompts=[[{"role": "user", "content": PROMPT}] for _ in pieces],
            audios=batch,
            audio_lens=lens,
            max_new_tokens=max_new_tokens,
        )
    texts = [SPECIAL_TOKENS.sub("", model.tokenizer.ids_to_text(row.cpu())).strip() for row in ids]
    return " ".join(t for t in texts if t)


def _warm() -> None:
    rng = np.random.default_rng(0)
    for seconds in (1, 5):
        _decode((rng.standard_normal(SAMPLE_RATE * seconds) * 0.01).astype(np.float32))


started = time.perf_counter()
_warm()
log.info("loaded %s and warmed in %.1fs", MODEL_ID, time.perf_counter() - started)

app = FastAPI(title="GB10 Canary-Qwen", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model_name: str = Form("canary", alias="model"),
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
