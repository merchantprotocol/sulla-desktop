---
schemaversion: 1
slug: elevenlabs-audio-generator
title: "Audio Generator (ElevenLabs)"
section: "Standard Operating Procedures"
category: "Content Creation"
tags:
  - skill
  - audio
  - elevenlabs
  - music
  - sound-effects
  - voice
  - tts
order: 5
locked: true
author: seed
---

# Audio Generator (ElevenLabs)

**Triggers**: Human says "generate audio", "create music", "sound effects", "voice clip", "elevenlabs", "audio generator", "text to speech", "make a sound", "create audio".

Generate music, sound effects, and voice clips using the ElevenLabs API.

---

## Tool Mapping

| Step | Tool | Notes |
|------|------|-------|
| Check ElevenLabs credentials | `integration_get_credentials` | `integrationId: "elevenlabs"` — need `api_key` |
| Create project PRD | `create_project` | Creates the project folder + PROJECT.md |
| Create output directories | `fs_mkdir` | Create `~/sulla/projects/<project-name>/audio/music`, `audio/sfx`, `audio/voice` |
| Generate music | `exec` | curl ElevenLabs music generation endpoint |
| Generate sound effects | `exec` | curl ElevenLabs SFX endpoint |
| Generate voice clip | `exec` | curl ElevenLabs TTS endpoint |
| Present audio to user | respond with markdown | `[🎵 Listen: filename.mp3](file:///path/to/file.mp3)` |

---

## Setup

### ElevenLabs Credentials
```
integration_get_credentials({ integrationId: "elevenlabs" })
```
Extract the `api_key` value. If not configured, tell the user to set up the ElevenLabs integration first.

---

## Default Workflow

### 1. Check credentials
Verify ElevenLabs API key is available via `integration_get_credentials`.

### 2. Create the project
```
create_project({
  project_name: "<project-name>",
  content: "---\ntitle: <Project Name>\nstatus: active\ntags: [audio, elevenlabs]\n---\n# <Project Name>\n\n<description of what audio to generate>"
})
```

### 3. Create output directories
```
fs_mkdir({ path: "~/sulla/projects/<project-name>/audio/music" })
fs_mkdir({ path: "~/sulla/projects/<project-name>/audio/sfx" })
fs_mkdir({ path: "~/sulla/projects/<project-name>/audio/voice" })
```

### 4. Generate audio

#### Music Generation
```bash
curl -X POST "https://api.elevenlabs.io/v1/music/generate" \
  -H "xi-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<descriptive music prompt>",
    "duration_seconds": 30,
    "output_format": "mp3_44100_128"
  }' \
  --output ~/sulla/projects/<project-name>/audio/music/<filename>.mp3
```

#### Sound Effects
```bash
curl -X POST "https://api.elevenlabs.io/v1/sound-effects/generate" \
  -H "xi-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<descriptive SFX prompt>",
    "duration_seconds": 5,
    "output_format": "mp3_44100_128"
  }' \
  --output ~/sulla/projects/<project-name>/audio/sfx/<filename>.mp3
```

#### Voice / Text-to-Speech
```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/<voice_id>" \
  -H "xi-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "<text to speak>",
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
      "stability": 0.5,
      "similarity_boost": 0.75
    }
  }' \
  --output ~/sulla/projects/<project-name>/audio/voice/<filename>.mp3
```

### 5. Present to user
After generating, present each audio file as a clickable link:
```
[🎵 Listen: background-music.mp3](file:///Users/<user>/sulla/projects/<project-name>/audio/music/background-music.mp3)
```

---

## Directory Structure
```
~/sulla/projects/<project-name>/
├── PROJECT.md
├── audio/
│   ├── music/          # Generated music tracks
│   ├── sfx/            # Generated sound effects
│   └── voice/          # Generated voice clips
└── README.md
```

## Tips
- **Music prompts**: Be descriptive about genre, tempo, mood, instruments. E.g., "upbeat electronic lo-fi beat with soft piano and vinyl crackle, 90 BPM"
- **SFX prompts**: Describe the sound precisely. E.g., "mechanical keyboard typing rapidly, close-up recording"
- **Voice**: Use `eleven_multilingual_v2` model for best quality. Default voice IDs can be listed via the ElevenLabs API.
- **Formats**: `mp3_44100_128` is good default. Other options: `mp3_44100_192`, `pcm_16000`, `pcm_44100`
