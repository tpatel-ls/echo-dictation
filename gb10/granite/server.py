"""
Granite Speech 4.1 2B speech recognizer for Echo, served in-process with Hugging Face transformers.

  Echo -> auth shim (Bearer key, routes `model=granite*`) -> THIS server (127.0.0.1:8005)

Same OpenAI-compatible POST /v1/audio/transcriptions contract as the other GB10 routes. Granite
pairs a CTC conformer encoder with a Granite 4.0 LLM decoder (Apache-2.0, AMI-Cleaned WER 7.06) and
takes a keyword list in its prompt, which biases it toward a meeting's names and company terms
(a product name, a colleague's name). Echo uses it as the meeting vocabulary model, borrowing only
its one-for-one spelling of listed terms; it is not the default final model, because the list also
makes it insert listed names nobody said (docs/gb10-asr-upgrade.md).

`prompt` is a comma list of keywords for the model's keyword biasing. The model card's keyword
prompt ("transcribe the speech to text. Keywords: ...") returns lowercase text with no punctuation,
and appending the keywords to the punctuation prompt drops most punctuation and once invented a
name. Listing the keywords first, then asking for punctuation and capitalization, kept both on
Echo's real meetings (see docs/gb10-asr-upgrade.md); Echo still borrows sentence breaks from
Parakeet where Granite leaves them out. Decoding is greedy (`temperature` is accepted and ignored), so the
same clip always gives the same text. Audio longer than 40 s is split at the quietest point near
each boundary. Binds to loopback and has no auth of its own; the log carries durations, timings and
keyword counts, never audio, text or keywords.
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
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

MODEL_ID = os.environ.get("GRANITE_MODEL", "ibm-granite/granite-speech-4.1-2b")
SAMPLE_RATE = 16_000
MAX_CHUNK_S = 35
MIN_CHUNK_S = 20
# The model card's punctuation prompt, and the same request with the keyword list in front of it.
PROMPT = "<|audio|>transcribe the speech with proper punctuation and capitalization."
KEYWORD_PROMPT = "<|audio|>Keywords: {}. transcribe the speech with proper punctuation and capitalization."
# Granite was trained on lists of 1 to 200 words; anything past that is dropped, not rejected.
MAX_KEYWORDS = 200
MAX_KEYWORD_CHARS = 2000

log = logging.getLogger("granite")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

processor = AutoProcessor.from_pretrained(MODEL_ID)
tokenizer = processor.tokenizer
model = AutoModelForSpeechSeq2Seq.from_pretrained(MODEL_ID, dtype=torch.bfloat16).to("cuda").eval()

# One GPU stream: requests queue here instead of contending inside CUDA.
gpu_lock = asyncio.Lock()


def keywords_of(prompt: str | None) -> list[str]:
    """The comma list as clean, distinct keywords, capped to what the model was trained on."""
    out, seen, chars = [], set(), 0
    for raw in (prompt or "").replace("\n", ",").split(","):
        word = " ".join(raw.split())
        if not word or word.lower() in seen:
            continue
        if len(out) >= MAX_KEYWORDS or chars + len(word) > MAX_KEYWORD_CHARS:
            break
        seen.add(word.lower())
        out.append(word)
        chars += len(word) + 2
    return out


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


def _decode_piece(piece: np.ndarray, user_prompt: str) -> str:
    chat = [{"role": "user", "content": user_prompt}]
    text_prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
    wav = torch.from_numpy(piece).unsqueeze(0)
    inputs = processor(text_prompt, wav, device="cuda", return_tensors="pt").to("cuda")
    max_new_tokens = int(48 + piece.size / SAMPLE_RATE * 10)
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False, num_beams=1)
    new_tokens = out[0, inputs["input_ids"].shape[-1] :].unsqueeze(0)
    return tokenizer.batch_decode(new_tokens, add_special_tokens=False, skip_special_tokens=True)[0].strip()


def _decode(audio: np.ndarray, keywords: list[str]) -> str:
    user_prompt = KEYWORD_PROMPT.format(", ".join(keywords)) if keywords else PROMPT
    texts = [_decode_piece(piece, user_prompt) for piece in _chunks(audio)]
    return " ".join(t for t in texts if t)


def _warm() -> None:
    rng = np.random.default_rng(0)
    for seconds in (1, 5):
        _decode((rng.standard_normal(SAMPLE_RATE * seconds) * 0.01).astype(np.float32), [])


started = time.perf_counter()
_warm()
log.info("loaded %s and warmed in %.1fs", MODEL_ID, time.perf_counter() - started)

app = FastAPI(title="GB10 Granite Speech", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "max_memory_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model_name: str = Form("granite", alias="model"),
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
    keywords = keywords_of(prompt)

    started = time.perf_counter()
    text = ""
    if audio.size >= SAMPLE_RATE // 10:  # under 100 ms is not speech
        async with gpu_lock:
            text = await asyncio.to_thread(_decode, np.ascontiguousarray(audio), keywords)
    log.info(
        "decoded %.2fs audio with %d keywords in %.0f ms",
        audio.size / SAMPLE_RATE, len(keywords), (time.perf_counter() - started) * 1000,
    )

    if response_format == "text":
        return PlainTextResponse(text + "\n")
    return JSONResponse({"text": text})


def _error(message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": "invalid_request_error"}}, status_code=400)
