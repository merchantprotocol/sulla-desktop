# LlamaCppService — Local LLM Inference

## Overview

`LlamaCppService` provides local LLM inference by managing a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp) installation. It downloads pre-built `llama-server` binaries from GitHub releases and runs them as a child process, exposing an **OpenAI-compatible API on port 30114**.

Source: `pkg/rancher-desktop/agent/services/LlamaCppService.ts`

## What llama-server Is

`llama-server` is the HTTP server component of the llama.cpp project. It loads a GGUF-format model into memory and serves an OpenAI-compatible `/v1/chat/completions` endpoint. Sulla uses it as the local inference backend — no external API keys or cloud services are required for basic operation.

The server binds to `127.0.0.1:30114` and is only accessible from the local machine.

## Relationship to ChatCompletionsServer (Port 3000)

The `ChatCompletionsServer` on port 3000 is Sulla's main conversational API layer. It sits in front of the local llama-server and acts as a routing and orchestration layer:

- **Port 3000** (`ChatCompletionsServer`): Receives user messages, runs them through the agent graph system (`GraphRegistry`), handles WebSocket integration with the tasker channel, and manages conversation threads.
- **Port 30114** (`llama-server`): The raw LLM inference endpoint. ChatCompletionsServer forwards inference requests here when using the local model.

The separation allows the agent system to add context, tool calls, and multi-step reasoning on top of the bare model inference.

## Model Management

### GGUF Format

All models are stored in GGUF format (a binary format designed for llama.cpp). Models are downloaded from HuggingFace and stored in `~/Library/Application Support/rancher-desktop/llm/models/`.

### Available Models

The `GGUF_MODELS` registry defines all downloadable models:

| Key | Display Name | Size | Min RAM | Description |
|-----|-------------|------|---------|-------------|
| `qwen3.5-9b` | Qwen3.5 9B | 5.6GB | 8GB | Latest generation, strong reasoning (default) |
| `qwen3.5-4b` | Qwen3.5 4B | 2.7GB | 4GB | Balanced performance and speed |
| `qwen3.5-0.8b` | Qwen3.5 0.8B | 600MB | 1GB | Fast and lightweight |
| `qwen2-1.5b` | Qwen2 1.5B | 1.0GB | 2GB | Efficient for basic tasks |
| `phi3-mini` | Phi-3 Mini | 2.2GB | 4GB | Microsoft 3.8B, great reasoning |
| `gemma-2b` | Gemma 2B | 1.7GB | 4GB | Google lightweight model |
| `llama3.2-1b` | Llama 3.2 1B | 1.3GB | 4GB | Meta's smallest Llama 3.2 |
| `llama3.2-3b` | Llama 3.2 3B | 2.0GB | 4GB | Compact, balanced performance |
| `mistral-7b` | Mistral 7B | 4.1GB | 5GB | Strong coding and reasoning |
| `qwen2-7b` | Qwen2 7B | 4.4GB | 5GB | Strong performance |
| `llama3.1-8b` | Llama 3.1 8B | 4.7GB | 6GB | Excellent all-around |
| `gemma-7b` | Gemma 7B | 5.0GB | 6GB | Google larger model |
| `codellama-7b` | Code Llama 7B | 3.8GB | 5GB | Specialized for code |

Models that define a `trainingRepo` (the Qwen3.5 family) support fine-tuning via the training system.

### Download Process

1. `downloadModel(modelKey)` checks if the GGUF file already exists on disk.
2. If missing, it performs a disk space check (`assertDiskSpace`).
3. The model is streamed to a `.tmp` file, then atomically renamed to avoid partial files on crash.

## Version Management

### llama.cpp Binary Versioning

- On first run, `ensure()` fetches the latest release tag from `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`.
- The correct platform-specific binary is downloaded and extracted (macOS arm64/x64, Linux x64/arm64/CUDA, Windows x64/arm64/CUDA).
- A `.version` file in the llama-cpp directory records the installed tag.
- On subsequent starts, `ensure()` no-ops if the `.version` file exists and the `llama-server` binary is found.
- `update()` forces a re-download to the latest release, even if already installed.

### GPU Detection

- **macOS**: Metal is always available; GPU offloading is always enabled.
- **Linux/Windows**: `nvidia-smi` is probed to detect NVIDIA GPUs. If found, the CUDA build variant is downloaded.
- The `--n-gpu-layers 999` flag offloads all layers to GPU when a GPU build is detected.

## Directory Structure

All paths are relative to `~/Library/Application Support/rancher-desktop/` (macOS):

```
llm/
  llama-cpp/          # llama-server binary + .version file
  models/             # Downloaded .gguf model files
  training/           # Training venv, models, and data
    .venv/            # Python virtual environment (unsloth + torch)
    documents_config.json
  feedback_queue/     # Conversation feedback for training
```

## Configuration Options

These settings are stored in `SullaSettingsModel` (PostgreSQL + Redis) and configurable through the Language Model Settings UI:

| Setting | Default | Description |
|---------|---------|-------------|
| `sullaModel` | `tinyllama:latest` | The active model key used for inference |
| `localTimeoutSeconds` | `120` | Maximum seconds to wait for a local inference response |
| `localRetryCount` | `2` | Number of retry attempts for failed local inference calls |

### Context Size

The `--ctx-size` parameter is calculated dynamically at server start based on available system RAM:

```
availableForContext = totalRAM - modelFileSize - 2GB (OS overhead)
contextTokens = availableForContext / 2 bytes per token
```

The result is clamped between 2,048 and 131,072 tokens and rounded down to the nearest 1,024.

## Server Lifecycle

1. **`ensure()`** — Downloads llama.cpp binaries if not already installed. Safe to call on every startup.
2. **`downloadModel(key)`** — Downloads the selected GGUF model if not on disk.
3. **`startServer(modelPath)`** — Spawns `llama-server` as a child process. Polls `/health` until the server responds (up to 60 seconds).
4. **`stopServer()`** — Sends `SIGTERM`, waits 5 seconds for graceful shutdown, then `SIGKILL` if needed.

## Training System

The service also manages an optional fine-tuning pipeline:

- `installTrainingDeps()` creates a Python venv with unsloth, torch, and document processing libraries.
- `downloadTrainingModel(key)` fetches the full-precision Unsloth model from HuggingFace for LoRA training.
- `runFullNightlyTraining(key)` runs the full pipeline: document processing followed by LoRA fine-tuning and GGUF export.
- Training requires Python 3.10+ and uses MLX on Apple Silicon or CUDA on Linux/Windows.
