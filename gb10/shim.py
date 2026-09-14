"""
OpenAI-compatible auth shim in front of the GB10 speech recognizers.

  Internet -> Tailscale Funnel (HTTPS) -> THIS shim (127.0.0.1:8080, Bearer auth)
     model=parakeet*  -> Parakeet TDT server   (127.0.0.1:8002, see parakeet/server.py)
     model=canary*    -> Canary-Qwen server    (127.0.0.1:8003, see canary/server.py)
     anything else    -> whisper.cpp whisper-server (127.0.0.1:8000)

Exposes POST /v1/audio/transcriptions (OpenAI multipart: `file` + `model`).
Auth: requires `Authorization: Bearer <KEY>` on every /v1/* request.
Audio that is already 16 kHz mono PCM16 WAV (what Echo sends) is forwarded as-is; anything else
(webm/opus, m4a, mp3, ...) is transcoded with ffmpeg first, so any OpenAI client works.
The key is read from KEY.txt (chmod 600); it is never baked into any image.
"""
import asyncio
import hmac
import io
import os
import wave

import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.requests import Request

KEY_PATH = os.environ.get("WHISPER_KEY_FILE", os.path.expanduser("~/whisper/KEY.txt"))
BACKEND = os.environ.get("WHISPER_BACKEND", "http://127.0.0.1:8000")
PARAKEET_BACKEND = os.environ.get("PARAKEET_BACKEND", "http://127.0.0.1:8002")
CANARY_BACKEND = os.environ.get("CANARY_BACKEND", "http://127.0.0.1:8003")
# OpenAI-contract recognizers, chosen by model-name prefix. Everything else is whisper.cpp.
NEMO_ROUTES = {"parakeet": PARAKEET_BACKEND, "canary": CANARY_BACKEND}
FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")

with open(KEY_PATH) as fh:
    API_KEY = fh.read().strip()
if not API_KEY:
    raise SystemExit(f"empty key in {KEY_PATH}")
EXPECTED_AUTH = f"Bearer {API_KEY}"

app = FastAPI(title="GB10 Speech", docs_url=None, redoc_url=None)
# One pooled client: keep-alive to the loopback backends instead of a new connection per request.
client = httpx.AsyncClient(timeout=600.0)


@app.middleware("http")
async def require_bearer(request: Request, call_next):
    # Auth is checked here, BEFORE FastAPI parses the (possibly large) multipart
    # body, so an unauthenticated POST returns 401 (not 422) even with no file.
    if request.url.path.startswith("/v1/"):
        provided = request.headers.get("authorization", "")
        if not hmac.compare_digest(provided, EXPECTED_AUTH):
            return JSONResponse(
                {"error": {"message": "Unauthorized", "type": "invalid_request_error", "code": 401}},
                status_code=401,
            )
    return await call_next(request)


@app.get("/health")
def health():
    return {
        "ok": True,
        "backend": BACKEND,
        "model": "whisper-1->large-v3-turbo",
        "routes": NEMO_ROUTES,
    }


def is_wav16k_mono(raw: bytes) -> bool:
    """True when the upload is already the 16 kHz mono PCM16 WAV both recognizers want."""
    try:
        with wave.open(io.BytesIO(raw)) as wav:
            return (
                wav.getnchannels() == 1
                and wav.getframerate() == 16000
                and wav.getsampwidth() == 2
                and wav.getcomptype() == "NONE"
            )
    except (wave.Error, EOFError):
        return False


async def to_wav16k(raw: bytes) -> bytes:
    """Transcode arbitrary audio bytes to 16 kHz mono PCM WAV via ffmpeg (stdin->stdout)."""
    if is_wav16k_mono(raw):
        return raw
    proc = await asyncio.create_subprocess_exec(
        FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(input=raw)
    if proc.returncode != 0 or not out:
        raise ValueError(err.decode("utf-8", "replace")[:500] or "ffmpeg failed")
    return out


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("whisper-1"),
    response_format: str = Form("json"),
    language: str | None = Form(None),
    temperature: float = Form(0.0),
    prompt: str | None = Form(None),
):
    raw = await file.read()
    try:
        wav = await to_wav16k(raw)
    except ValueError as exc:
        return JSONResponse(
            {"error": {"message": f"could not decode audio: {exc}", "type": "invalid_request_error"}},
            status_code=400,
        )

    files = {"file": ("audio.wav", wav, "audio/wav")}
    nemo_backend = next((url for prefix, url in NEMO_ROUTES.items() if model.lower().startswith(prefix)), None)
    if nemo_backend:
        resp = await client.post(
            f"{nemo_backend}/v1/audio/transcriptions",
            files=files,
            data={"model": model, "response_format": "json"},
        )
    else:
        data = {"response_format": "json", "temperature": str(temperature)}
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt
        resp = await client.post(f"{BACKEND}/inference", files=files, data=data)
    resp.raise_for_status()

    try:
        payload = resp.json()
        text = (payload.get("text") if isinstance(payload, dict) else str(payload)) or ""
    except ValueError:
        payload, text = {}, resp.text
    # whisper.cpp inserts newlines at segment boundaries; OpenAI returns clean
    # single-line text. Collapse all whitespace runs so dictation output is tidy.
    text = " ".join(text.split())

    if response_format == "text":
        return PlainTextResponse(text + "\n")
    if response_format == "verbose_json":
        extra = {k: v for k, v in payload.items() if k != "text"} if isinstance(payload, dict) else {}
        return JSONResponse({"task": "transcribe", "text": text, **extra})
    return JSONResponse({"text": text})
