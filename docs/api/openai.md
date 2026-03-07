# OpenAI-Compatible API

## Overview

Sulla provides an OpenAI-compatible API for interacting with AI models, enabling integration with tools like n8n that expect OpenAI API endpoints. The API supports chat completions, single completions, embeddings, model listing, and content moderation.

## Access

The API server automatically starts on port 3000 when Sulla is running.

**Local Access (from host):** `http://localhost:3000`

**Container Access (from Docker/Kubernetes pods):** `http://host.docker.internal:3000`

All endpoints are prefixed with `/v1/`.

**Health Check:** `GET /health`

## Authentication

Currently, no authentication is required. (Note: Standard OpenAI APIs use Bearer tokens in the Authorization header, but this implementation does not enforce authentication.)

## Endpoints

### GET /v1/models

Returns a list of available models based on configured providers (Grok, OpenAI, Ollama) and hardware constraints (CPU/RAM for Ollama models).

**Response Format:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "model-name",
      "object": "model",
      "created": 1234567890,
      "owned_by": "ollama" | "xai" | "openai"
    }
  ]
}
```

**Example:**
```bash
curl http://localhost:3000/v1/models
```

### POST /v1/chat/completions

Handles conversational AI interactions using chat messages.

**Request Format:**
```json
{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "model": "sulla",
  "temperature": 0.7,
  "max_tokens": 100,
  "stream": false
}
```

**Response Format:**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "sulla",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Hello! How can I help you?"},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "model": "sulla"
  }'
```

### POST /v1/completions

Provides single prompt text completions (legacy OpenAI style, not conversational).

**Request Format:**
```json
{
  "prompt": "Write a short story about",
  "model": "sulla",
  "max_tokens": 100,
  "temperature": 0.7
}
```

**Response Format:**
```json
{
  "id": "cmpl-123",
  "object": "text_completion",
  "created": 1234567890,
  "model": "sulla",
  "choices": [
    {
      "text": " a brave knight who...",
      "index": 0,
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 5,
    "completion_tokens": 20,
    "total_tokens": 25
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Once upon a time",
    "model": "sulla"
  }'
```

### POST /v1/embeddings

Generates vector embeddings for text input using configured Ollama embedding models.

**Request Format:**
```json
{
  "input": "Text to embed" | ["Text 1", "Text 2"],
  "model": "nomic-embed-text",
  "user": "optional-user-id"
}
```

**Response Format:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.123, -0.456, ...],
      "index": 0
    }
  ],
  "model": "nomic-embed-text",
  "usage": {
    "prompt_tokens": 3,
    "total_tokens": 3
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello world",
    "model": "nomic-embed-text"
  }'
```

### POST /v1/moderations

Checks content for harmful or inappropriate material. This implementation returns safe results for all inputs (not using OpenAI's actual moderation service).

**Request Format:**
```json
{
  "input": "Text to moderate" | ["Text 1", "Text 2"]
}
```

**Response Format:**
```json
{
  "id": "modr-123",
  "model": "text-moderation-stable",
  "results": [
    {
      "categories": {
        "hate": false,
        "hate/threatening": false,
        "self-harm": false,
        "sexual": false,
        "sexual/minors": false,
        "violence": false,
        "violence/graphic": false
      },
      "category_scores": {
        "hate": 0.0,
        "hate/threatening": 0.0,
        "self-harm": 0.0,
        "sexual": 0.0,
        "sexual/minors": 0.0,
        "violence": 0.0,
        "violence/graphic": 0.0
      },
      "flagged": false
    }
  ]
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/v1/moderations \
  -H "Content-Type: application/json" \
  -d '{
    "input": "This is a test message"
  }'
```

## Supported Models

- **Ollama Models:** Filtered by available CPU cores and RAM (tinyllama, llama2, llama3, codellama variants)
- **Remote Models:** Grok models (if Grok API key configured), OpenAI models (if OpenAI API key configured)

## Error Handling

All endpoints return standard HTTP status codes and JSON error responses:

```json
{
  "error": {
    "message": "Error description",
    "type": "error_type"
  }
}
```

Common error types: `invalid_request_error`, `internal_error`

## Integration API Endpoints

The same server also hosts integration API endpoints for calling third-party APIs (YouTube, GitHub, Postmark, etc.) with managed credentials. See [Integrations API](./integrations.md) for full documentation.
