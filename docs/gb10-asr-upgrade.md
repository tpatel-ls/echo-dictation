# GB10 speech-model upgrade

Echo accepts any OpenAI-compatible `POST /v1/audio/transcriptions` service. The client sends a
16 kHz mono WAV, `language=en`, `temperature=0`, and an optional vocabulary prompt. Changing the
model name in Echo only changes weights when the server actually routes that name to a distinct
model.

## Current route: Parakeet TDT 0.6B v2

The GB10 serves NVIDIA Parakeet TDT 0.6B v2 next to the Whisper large-v3-turbo route. Both sit
behind the same authenticated shim, so the switch is a model-name change in Echo:

| Echo model field | Route |
| --- | --- |
| `parakeet-tdt-0.6b-v2` | Parakeet TDT (NeMo, in-process on the GPU) |
| `whisper-1` (or anything else) | whisper.cpp large-v3-turbo, the rollback route |

Why Parakeet:

- It is non-autoregressive, so decode time barely grows with utterance length. On the GB10, a
  3-second sentence decodes in about 40 ms and a 21-second paragraph in about 75 ms, against
  about 180 ms and 325 ms through the Whisper route.
- The Open ASR leaderboard reports 6.05 average English WER for Parakeet TDT 0.6B v2 against
  7.83 for Whisper large-v3-turbo ([arXiv 2510.06961](https://arxiv.org/html/2510.06961v4)).
- Output is punctuated and capitalized, like Whisper.
- v2 is English-only, which matches Echo's pinned English. v3 adds 24 European languages at a
  small English WER cost.

Behavior differences Echo accounts for:

- Decoding is deterministic, so `temperature` and `prompt` are ignored. Balanced mode therefore
  runs a single decode for Parakeet models instead of the temperature ensemble; the dictionary's
  deterministic alias pass still runs client-side.
- The live preview in the recording bar is enabled only for Parakeet models, because repeated
  preview decodes would queue behind the final decode on a single Whisper server.

## Cross-model voting

Parakeet alone misheard short, context-free phrases ("mic testing" became "my testing"). Balanced
mode can decode several models at once and vote, configured by **Cross-check models** in Settings:

| Echo setting | Recommended value |
| --- | --- |
| Model (pasted text) | `whisper-1` |
| Cross-check models | `parakeet-tdt-0.6b-v2, canary-qwen-2.5b` |
| Preview model (live bubble) | `parakeet-tdt-0.6b-v2` |

- All models decode in parallel, so the wait is the slowest model, not the sum.
- Candidates are compared on written forms (`seven P R s` equals `7 PRs`). Two agreeing models win,
  keeping the better-punctuated text.
- Canary-Qwen 2.5B votes only on recordings under 6 seconds. Its LLM decoder takes about 300 ms on a
  short phrase but about 1.8 s on a 21-second paragraph on the GB10.
- Three short hypotheses with no majority go to the adjudicator. Longer recordings with no
  majority keep the main model rather than waiting on an LLM.
- A cross-check model gets one attempt with a 4-second limit, so a failing route never blocks a paste.

Each dictation appends per-stage timings (recognition, cleanup, paste; never text) to
`dictation.log` in Echo's user-data folder.

## Server layout

Files in [`gb10/`](../gb10):

- `parakeet/server.py`: FastAPI + NeMo recognizer on `127.0.0.1:8002`, loopback only, no auth.
- `parakeet/parakeet-server.service`: systemd **user** unit (no sudo needed).
- `canary/server.py` + `canary/canary-server.service`: Canary-Qwen 2.5B (NeMo SALM) on
  `127.0.0.1:8003`. Needs `pip install peft`, the `Qwen/Qwen3-1.7B` tokenizer files in the HF cache,
  and Python headers for Triton's JIT (`uv python install 3.12`, then point `C_INCLUDE_PATH` at its
  `include/python3.12` in a unit drop-in).
- `shim.py`: the authenticated public shim. Routes `model=parakeet*`, `model=canary*` and
  `model=granite*` to their servers, everything else to whisper.cpp, and skips ffmpeg when the upload is already 16 kHz mono
  PCM16 WAV.

Install on the GB10 (DGX OS, CUDA 13, aarch64):

```bash
mkdir -p ~/asr && cd ~/asr
python3 -m venv .venv && . .venv/bin/activate
pip install -U pip wheel setuptools
pip install --index-url https://download.pytorch.org/whl/cu130 torch torchaudio
echo "torch==$(python -c 'import torch;print(torch.__version__)')" > constraints.txt
pip install -c constraints.txt "nemo_toolkit[asr]" fastapi "uvicorn[standard]" python-multipart soundfile
python -c "from huggingface_hub import snapshot_download; snapshot_download('nvidia/parakeet-tdt-0.6b-v2')"
cp server.py ~/asr/ && cp parakeet-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now parakeet-server
curl -s http://127.0.0.1:8002/health
```

Then replace the shim, restart it, and set Echo's model field to `parakeet-tdt-0.6b-v2`.

Rollback: set Echo's model back to `whisper-1`. Nothing else changes.

## Meeting routes

Meeting notes add two routes to the same shim, behind the same Bearer key. Dictation's
`/v1/audio/transcriptions` is unchanged.

| Route | What it does |
| --- | --- |
| `POST /v1/audio/diarizations` | Forwards to the diarizer on `127.0.0.1:8004` (non-WAV uploads are transcoded first). Multipart `file`, optional `num_speakers`, `min_speakers`, `max_speakers`, `embeddings` (default true). Returns `{duration, model, embedding_model, embedding_dim, segments:[{start,end,speaker}], speakers:[{id, speech_seconds, turns, embedding}]}`. `segments` is the exclusive (non-overlapping) diarization, sorted. Embeddings are unit-length 256-d WeSpeaker centroids, `null` under 3 s of speech. Returns 502 while the diarizer is down. |
| `POST /v1/audio/segments` | Multipart `file` (16 kHz mono WAV, at most 600 s), `models` (comma list of 1-3 names), `segments` (JSON `[{id,start,end}]` in seconds, at most 400, each longer than 0 and at most 40 s, inside the file), optional `prompt` (at most 4000 characters: a comma list of keywords, passed to every clip's decode; Granite and whisper.cpp use it, Parakeet and Canary ignore it). Each clip is decoded through the same model routing as `/v1/audio/transcriptions`. Each model decodes its clips one at a time, so dictation interleaves on the GPU locks, and the models run concurrently. Returns `{results:[{id, texts:{<model>: text}}]}` in request order. A clip that fails for a model is left out of that model's `texts`. Invalid requests get a 400 with the usual error shape. |

Files in [`gb10/diarizer/`](../gb10/diarizer):

- `server.py`: FastAPI + pyannote.audio 4 running `pyannote/speaker-diarization-community-1`
  (CC-BY-4.0) from a local copy, loopback only, no auth. Stateless: it logs durations and timings,
  never audio, turns or embeddings. One GPU lock; `DIAR_BATCH` (default 32) sets the segmentation
  and embedding batch sizes.
- `diarizer-server.service`: systemd **user** unit with `HF_HUB_OFFLINE=1` and
  `PYANNOTE_METRICS_ENABLED=0` (pyannote telemetry is on by default).

Install on the GB10. The diarizer gets its own venv, because NeMo and pyannote pin overlapping
`lightning` ranges:

```bash
# 0. Once, in a browser: accept the conditions on the Hugging Face page of
#    pyannote/speaker-diarization-community-1, then create a read token.
mkdir -p ~/diar/models && cd ~/diar
python3 -m venv .venv && . .venv/bin/activate
pip install -U pip wheel setuptools
pip install --index-url https://download.pytorch.org/whl/cu130 torch==2.11.0 torchaudio==2.11.0 "torchcodec==0.11.*"
echo "torch==$(python -c 'import torch;print(torch.__version__)')" > constraints.txt
pip install -c constraints.txt "pyannote.audio==4.0.7" fastapi "uvicorn[standard]" python-multipart soundfile
PYANNOTE_METRICS_ENABLED=0 python -c "from pyannote.audio.telemetry import set_telemetry_metrics; \
  set_telemetry_metrics(False, save_choice_as_default=True)"

# 1. Download the pipeline once with the token (stored mode 600, never in the unit), then run offline.
install -m 600 /dev/stdin ~/.cache/huggingface/token   # paste the token, then Ctrl-D
python -c "from huggingface_hub import snapshot_download; \
  snapshot_download('pyannote/speaker-diarization-community-1', local_dir='models/speaker-diarization-community-1')"

# 2. Service.
cp server.py ~/diar/ && cp diarizer-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now diarizer-server
curl -s http://127.0.0.1:8004/health
```

Deploy the shim. A restart interrupts dictation for a moment, so validate first:

```bash
cp -p ~/whisper/shim.py ~/whisper/shim.py.bak-$(date +%F)
# Validate the new file on a spare loopback port before touching the live one.
mkdir -p /tmp/shim-new && cp shim.py /tmp/shim-new/
(cd /tmp/shim-new && WHISPER_KEY_FILE=~/whisper/KEY.txt ~/whisper/.venv/bin/uvicorn shim:app --host 127.0.0.1 --port 18080 &)
curl -s http://127.0.0.1:18080/health
curl -s -H "Authorization: Bearer $(cat ~/whisper/KEY.txt)" -F file=@probe.wav -F model=parakeet-tdt-0.6b-v2 \
  http://127.0.0.1:18080/v1/audio/transcriptions
pkill -f "[p]ort 18080"
cp /tmp/shim-new/shim.py ~/whisper/shim.py && systemctl --user restart whisper-shim
```

Then check `/health` and one transcription per model (`whisper-1`, `parakeet-tdt-0.6b-v2`,
`canary-qwen-2.5b`) through the public URL.

Rollback: `cp ~/whisper/shim.py.bak-<date> ~/whisper/shim.py && systemctl --user restart whisper-shim`,
and `systemctl --user disable --now diarizer-server`. Dictation never depends on either meeting
route, so turning meetings off in Echo is also enough.

## Granite Speech 4.1 2B with keywords (meeting final pass)

IBM's `ibm-granite/granite-speech-4.1-2b` (Apache-2.0, ungated, AMI-Cleaned WER 7.06 against
Canary-Qwen's 7.91) takes a keyword list in its prompt. Echo's meeting final pass sends one with
every `/v1/audio/segments` request: your name, the calendar attendees and window-title names for
the meeting, everyone whose voice Echo remembers, then your dictionary words (at most 100). Models
that take no prompt ignore it.

| Echo setting | Route |
| --- | --- |
| Meetings › Vocabulary model `granite-speech-4.1-2b` (the default) | Granite server on `127.0.0.1:8005`, keyword-biased |
| Meetings › Final model `granite-speech-4.1-2b` (not the default) | Same server, as the whole transcript |

**Granite is the vocabulary model, not the final model.** Canary-Qwen stays the final model and
Parakeet the check model. Granite decodes the same clips in the same `/v1/audio/segments` request,
and Echo borrows only its spelling of listed terms (`src/shared/vocab-transplant.ts`): a word of
Canary's text is replaced by Granite's word only when it is a one-for-one substitution between
words both texts agree on, Granite's word (or a two-word span) is on the keyword list, and the two
sound alike (a small sound key plus a bounded edit distance). A name Granite added, dropped or
merged is never taken, so it can only replace a mishearing of itself. Clearing the setting turns
this off; if the Granite route fails, the pass finishes without it.

On two real meetings (a 23-minute call with a reference transcript, and a 12-minute Slack
huddle), with the same diarization, the same final pass and the user's own dictionary, counting
13 spoken occurrences of listed or listable terms (company and product names, acronyms,
colleagues' names):

| Final pass | Agreement with the reference, fillers removed (precision / recall) | Terms right, of 13 | Listed names inserted that nobody said | Transcription time (call / huddle) |
| --- | --- | --- | --- | --- |
| Canary-Qwen alone | 0.957 / 0.947 | 6 | 0 | 110 s / 76 s |
| Granite as the final model, no keywords | 0.958 / 0.930 | 5 | 0 | 109 s / 74 s |
| Granite as the final model, with keywords | 0.958 / 0.934 | 10 | 3 | 106 s / 74 s |
| Canary-Qwen + Granite vocabulary (default) | unchanged: only 1-for-1 term swaps | 9 | 0 | about twice Canary's |

- As the final model, the keyword list makes Granite insert listed names nobody said (a
  colleague's name, added to three sentences). A longer test list also produced name-only speaker
  prefixes. It also drops more real words than Canary.
- As the vocabulary model, Granite fixed an acronym one letter off, a colleague's name, one of
  three product-name mentions, and "Cloud" for Claude, and inserted nothing. The other two
  product-name mentions Granite also misheard; a possessive name it heard right is not on the
  keyword list, so it is not taken.
- The three models run concurrently, but Canary and Granite share the GB10's GPU: one 5-minute
  batch took 14 s with Canary alone, 14 s with Granite alone and 29 s with both. The final pass
  runs after the call, so this costs waiting time, not accuracy.

Files in [`gb10/granite/`](../gb10/granite):

- `server.py`: FastAPI + transformers, the same `/v1/audio/transcriptions` contract as the other
  routes. `prompt` is a comma list of keywords. Loopback only, no auth, one GPU lock, greedy
  decoding, clips over 40 s split at the quietest point. It logs durations, timings and keyword
  counts, never audio, text or keywords. About 4.4 GB of GPU memory.
- `granite-server.service`: systemd **user** unit with `HF_HUB_OFFLINE=1`.

The prompt. The model card's keyword prompt (`transcribe the speech to text. Keywords: ...`)
returns lowercase text without punctuation. Adding the keywords after the card's punctuation
prompt drops most punctuation, and on one real clip it put an invented name at the start. The
server lists the keywords first and then asks for punctuation and capitalization:
`Keywords: <list>. transcribe the speech with proper punctuation and capitalization.` It still
leaves out some sentence breaks, so Echo takes the missing ones (and sentence capitals) from
Parakeet's text of the same clip, never its words.

Install on the GB10. Granite gets its own venv, so the NeMo venv (`~/asr`) is never touched:

```bash
mkdir -p ~/granite && cd ~/granite
python3 -m venv .venv && . .venv/bin/activate
pip install -U pip wheel setuptools
pip install --index-url https://download.pytorch.org/whl/cu130 torch==2.11.0 torchaudio==2.11.0
echo "torch==$(python -c 'import torch;print(torch.__version__)')" > constraints.txt
pip install -c constraints.txt "transformers>=4.52.1" peft accelerate soundfile fastapi "uvicorn[standard]" python-multipart
# The model is ungated: no token needed. Download once, then the unit runs offline.
python -c "from huggingface_hub import snapshot_download; snapshot_download('ibm-granite/granite-speech-4.1-2b')"
cp server.py ~/granite/ && cp granite-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now granite-server
curl -s http://127.0.0.1:8005/health
```

`torchaudio` is required by the model's feature extractor even though the server reads audio with
soundfile. Then deploy the shim as above (backup, spare port, one restart) and check one
transcription per model, including `granite-speech-4.1-2b` with a `prompt`.

Rollback: set Meetings › Final model back to `canary-qwen-2.5b`. To remove the route too,
`systemctl --user disable --now granite-server` and restore the shim backup. Dictation never uses
Granite.

## Candidates for a later A/B

- **Qwen3-ASR-1.7B** and **Canary-Qwen-2.5B** report lower leaderboard WER (5.76 and 5.63) but use
  LLM decoders, so they are roughly an order of magnitude slower per request and not deterministic.
  Evaluate them on real dictations with names, numbers, and self-corrections before switching.
- NVIDIA's Speech NIM supports only Parakeet 1.1B CTC English and 1.1B RNNT Multilingual on DGX
  Spark ([support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html)),
  which is why this route runs NeMo directly.
