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

## Server layout

Files in [`gb10/`](../gb10):

- `parakeet/server.py`: FastAPI + NeMo recognizer on `127.0.0.1:8002`, loopback only, no auth.
- `parakeet/parakeet-server.service`: systemd **user** unit (no sudo needed).
- `shim.py`: the authenticated public shim. Routes `model=parakeet*` to Parakeet, everything else
  to whisper.cpp, and skips ffmpeg when the upload is already 16 kHz mono PCM16 WAV.

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

## Candidates for a later A/B

- **Qwen3-ASR-1.7B** and **Canary-Qwen-2.5B** report lower leaderboard WER (5.76 and 5.63) but use
  LLM decoders, so they are roughly an order of magnitude slower per request and not deterministic.
  Evaluate them on real dictations with names, numbers, and self-corrections before switching.
- NVIDIA's Speech NIM supports only Parakeet 1.1B CTC English and 1.1B RNNT Multilingual on DGX
  Spark ([support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html)),
  which is why this route runs NeMo directly.
