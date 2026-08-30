# GB10 speech-model upgrade

Echo accepts any OpenAI-compatible `POST /v1/audio/transcriptions` service. The client sends a
16 kHz mono WAV, `language=en`, `temperature=0`, and an optional vocabulary prompt. Changing the
model name in Echo only changes weights when the server actually routes that name to a distinct
model.

## Recommended evaluation: Qwen3-ASR-1.7B

Qwen3-ASR-1.7B is the first model to A/B against the current Whisper large-v3-turbo backend. Its
publisher reports state-of-the-art open-model results and better English WER than Whisper large-v3
on Common Voice, FLEURS, MLS, VoxPopuli, GigaSpeech, and LibriSpeech test-other, though Whisper or
other systems still win individual sets. It supports streaming and offline inference, and vLLM
exposes it through the same OpenAI transcription API Echo already uses.

Primary references:

- [Qwen3-ASR model card, evaluation, and vLLM transcription API](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [Qwen3-ASR Transformers documentation](https://huggingface.co/docs/transformers/model_doc/qwen3_asr)

Do not remove the working Whisper service during evaluation. Run Qwen on a second port, route a
second model alias to it, and replay a private test set of real dictations with accents, names,
numbers, short commands, background noise, and self-corrections. Compare normalized word error
rate, first-request latency, warm latency, and failure rate before changing the default route.

The official vLLM serving shape is:

```bash
vllm serve Qwen/Qwen3-ASR-1.7B \
  --host 0.0.0.0 \
  --port 8001 \
  --dtype bfloat16
```

Use the current authenticated HTTPS reverse proxy in front of that port. In Echo, point the model
field at `Qwen/Qwen3-ASR-1.7B` only after the proxy routes that identifier to the new service.

## DGX Spark-supported alternative

NVIDIA's current Speech NIM support matrix explicitly supports Parakeet 1.1B CTC English and
Parakeet 1.1B RNNT Multilingual on DGX Spark. This is the lower-risk vendor-supported GB10 path,
but Riva/NIM does not expose Echo's OpenAI transcription contract directly, so it needs a small
adapter before it is drop-in compatible.

- [NVIDIA Speech NIM ASR support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html)

Keep large-v3-turbo as the rollback route until the real-dictation A/B set demonstrates that the
replacement improves both accuracy and warm latency.
