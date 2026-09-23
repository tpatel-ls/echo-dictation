"""
OpenAI-compatible auth shim in front of the GB10 speech recognizers.

  Internet -> Tailscale Funnel (HTTPS) -> THIS shim (127.0.0.1:8080, Bearer auth)
     model=parakeet*  -> Parakeet TDT server   (127.0.0.1:8002, see parakeet/server.py)
     model=canary*    -> Canary-Qwen server    (127.0.0.1:8003, see canary/server.py)
     model=granite*   -> Granite Speech server (127.0.0.1:8005, see granite/server.py)
     anything else    -> whisper.cpp whisper-server (127.0.0.1:8000)
     diarizations     -> pyannote diarizer     (127.0.0.1:8004, see diarizer/server.py)

Exposes POST /v1/audio/transcriptions (OpenAI multipart: `file` + `model`), plus two routes for
Echo's meeting notes:
  POST /v1/audio/diarizations  speaker turns + per-speaker voice embeddings (forwarded as-is)
  POST /v1/audio/segments      decode many clips of one WAV with 1-3 models in one request
Auth: requires `Authorization: Bearer <KEY>` on every /v1/* request.
Audio that is already 16 kHz mono PCM16 WAV (what Echo sends) is forwarded as-is; anything else
(webm/opus, m4a, mp3, ...) is transcoded with ffmpeg first, so any OpenAI client works.
The key is read from KEY.txt (chmod 600); it is never baked into any image.
"""
import asyncio
import hmac
import io
import json
import logging
import os
import time
import wave

import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.requests import Request

KEY_PATH = os.environ.get("WHISPER_KEY_FILE", os.path.expanduser("~/whisper/KEY.txt"))
BACKEND = os.environ.get("WHISPER_BACKEND", "http://127.0.0.1:8000")
PARAKEET_BACKEND = os.environ.get("PARAKEET_BACKEND", "http://127.0.0.1:8002")
CANARY_BACKEND = os.environ.get("CANARY_BACKEND", "http://127.0.0.1:8003")
GRANITE_BACKEND = os.environ.get("GRANITE_BACKEND", "http://127.0.0.1:8005")
DIAR_BACKEND = os.environ.get("DIAR_BACKEND", "http://127.0.0.1:8004")
# OpenAI-contract recognizers, chosen by model-name prefix. Everything else is whisper.cpp.
NEMO_ROUTES = {"parakeet": PARAKEET_BACKEND, "canary": CANARY_BACKEND, "granite": GRANITE_BACKEND}
# Of those, the ones that use `prompt` (Granite: a keyword list). whisper.cpp always gets it.
PROMPT_ROUTES = ("granite",)
MAX_PROMPT_CHARS = 4000
FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
SAMPLE_RATE = 16_000
# /v1/audio/segments limits: one request is at most one batch of a meeting's final pass.
MAX_SEGMENTS = 400
MAX_SEGMENT_S = 40.0  # Canary-Qwen's training cap
MAX_SEGMENTS_FILE_S = 600.0
MAX_SEGMENT_MODELS = 3

log = logging.getLogger("shim")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

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
        "diarizer": DIAR_BACKEND,
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

    payload, text = await recognize(wav, model, language, temperature, prompt)

    if response_format == "text":
        return PlainTextResponse(text + "\n")
    if response_format == "verbose_json":
        extra = {k: v for k, v in payload.items() if k != "text"} if isinstance(payload, dict) else {}
        return JSONResponse({"task": "transcribe", "text": text, **extra})
    return JSONResponse({"text": text})


async def recognize(
    wav: bytes, model: str, language: str | None, temperature: float, prompt: str | None
) -> tuple[object, str]:
    """Decode one 16 kHz mono WAV on the backend `model` routes to. Returns (payload, text)."""
    files = {"file": ("audio.wav", wav, "audio/wav")}
    nemo_backend = next((url for prefix, url in NEMO_ROUTES.items() if model.lower().startswith(prefix)), None)
    if nemo_backend:
        data = {"model": model, "response_format": "json"}
        if prompt and model.lower().startswith(PROMPT_ROUTES):
            data["prompt"] = prompt
        resp = await client.post(f"{nemo_backend}/v1/audio/transcriptions", files=files, data=data)
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
    return payload, " ".join(text.split())


@app.post("/v1/audio/diarizations")
async def diarizations(
    file: UploadFile = File(...),
    num_speakers: int | None = Form(None),
    min_speakers: int | None = Form(None),
    max_speakers: int | None = Form(None),
    embeddings: bool = Form(True),
):
    raw = await file.read()
    try:
        wav = await to_wav16k(raw)
    except ValueError as exc:
        return _bad_request(f"could not decode audio: {exc}")
    fields = {"num_speakers": num_speakers, "min_speakers": min_speakers, "max_speakers": max_speakers}
    data = {name: str(value) for name, value in fields.items() if value is not None}
    data["embeddings"] = "true" if embeddings else "false"
    try:
        resp = await client.post(
            f"{DIAR_BACKEND}/v1/audio/diarizations",
            files={"file": ("audio.wav", wav, "audio/wav")},
            data=data,
            timeout=1800.0,  # an hour of audio takes minutes, and it may queue behind another meeting
        )
    except httpx.HTTPError as exc:
        return JSONResponse(
            {"error": {"message": f"diarizer unavailable: {type(exc).__name__}", "type": "server_error"}},
            status_code=502,
        )
    try:
        body = resp.json()
    except ValueError:
        body = {"error": {"message": f"diarizer returned {resp.status_code}", "type": "server_error"}}
    return JSONResponse(body, status_code=resp.status_code)


@app.post("/v1/audio/segments")
async def segment_transcriptions(
    file: UploadFile = File(...),
    models: str = Form(...),
    segments: str = Form(...),
    prompt: str | None = Form(None),
):
    """Decode each `{id, start, end}` clip (seconds) of one WAV with every model in `models`.

    `prompt` (optional) is passed to every clip's decode; the models that use one (Granite's
    keyword list, whisper.cpp's initial prompt) are biased by it, the others ignore it.

    Each model decodes its clips one at a time, through the same routes as
    /v1/audio/transcriptions, so live dictation interleaves on each backend's GPU lock instead of
    queueing behind a whole batch; the models run concurrently. A clip that fails for a model is
    left out of that model's texts and the request still succeeds.
    """
    names = list(dict.fromkeys(m.strip() for m in models.split(",") if m.strip()))
    if not 1 <= len(names) <= MAX_SEGMENT_MODELS:
        return _bad_request(f"models must list 1-{MAX_SEGMENT_MODELS} model names")
    if prompt and len(prompt) > MAX_PROMPT_CHARS:
        return _bad_request(f"prompt is longer than {MAX_PROMPT_CHARS} characters")

    raw = await file.read()
    try:
        with wave.open(io.BytesIO(await to_wav16k(raw))) as wav:
            pcm = wav.readframes(wav.getnframes())
    except (ValueError, wave.Error, EOFError) as exc:
        return _bad_request(f"could not decode audio: {exc}")
    frames = len(pcm) // 2
    duration = frames / SAMPLE_RATE
    if duration > MAX_SEGMENTS_FILE_S:
        return _bad_request(f"audio is {duration:.1f} s; at most {MAX_SEGMENTS_FILE_S:.0f} s per request")

    try:
        clips = _parse_segments(segments, duration)
    except ValueError as exc:
        return _bad_request(str(exc))

    def clip_wav(start: float, end: float) -> bytes:
        first, last = round(start * SAMPLE_RATE), min(frames, round(end * SAMPLE_RATE))
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm[first * 2 : last * 2])
        return out.getvalue()

    async def run_model(model: str) -> tuple[dict[str, str], int]:
        texts: dict[str, str] = {}
        failures = 0
        for clip_id, start, end in clips:
            try:
                _, texts[clip_id] = await recognize(clip_wav(start, end), model, "en", 0.0, prompt or None)
            except Exception as exc:  # one bad clip must not sink the batch
                failures += 1
                log.warning("segments: %s failed on a %.1fs clip: %s", model, end - start, type(exc).__name__)
        return texts, failures

    started = time.perf_counter()
    outcomes = await asyncio.gather(*(run_model(m) for m in names))
    log.info(
        "segments: %d clips (%.1fs of %.1fs audio) x %s in %.0f ms, %d failed",
        len(clips), sum(e - s for _, s, e in clips), duration, ",".join(names),
        (time.perf_counter() - started) * 1000, sum(f for _, f in outcomes),
    )
    by_model = dict(zip(names, (texts for texts, _ in outcomes)))
    return JSONResponse({
        "results": [
            {"id": clip_id, "texts": {m: by_model[m][clip_id] for m in names if clip_id in by_model[m]}}
            for clip_id, _, _ in clips
        ]
    })


def _parse_segments(field: str, duration: float) -> list[tuple[str, float, float]]:
    """Validate the `segments` JSON: `[{id, start, end}]`, unique ids, 0 < length <= 40 s, in the file."""
    try:
        items = json.loads(field)
    except ValueError:
        raise ValueError("segments is not valid JSON") from None
    if not isinstance(items, list) or not items:
        raise ValueError("segments must be a non-empty JSON array")
    if len(items) > MAX_SEGMENTS:
        raise ValueError(f"at most {MAX_SEGMENTS} segments per request")
    clips, seen = [], set()
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"segments[{i}] is not an object")
        clip_id, start, end = item.get("id"), item.get("start"), item.get("end")
        if not isinstance(clip_id, str) or not clip_id:
            raise ValueError(f"segments[{i}].id must be a non-empty string")
        if clip_id in seen:
            raise ValueError(f"segments[{i}].id {clip_id!r} is repeated")
        seen.add(clip_id)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, end)):
            raise ValueError(f"segments[{i}] start and end must be numbers")
        if not 0 < end - start <= MAX_SEGMENT_S:
            raise ValueError(f"segments[{i}] must last between 0 and {MAX_SEGMENT_S:.0f} s")
        if start < 0 or end > duration + 0.01:  # allow rounding at the very end of the file
            raise ValueError(f"segments[{i}] lies outside the {duration:.2f} s of audio")
        clips.append((clip_id, float(start), float(end)))
    return clips


def _bad_request(message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": "invalid_request_error"}}, status_code=400)
