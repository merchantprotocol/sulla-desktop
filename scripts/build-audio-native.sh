#!/usr/bin/env bash
#
# Build native audio-driver binaries for the current platform.
# Called automatically by `yarn build` before the main build step.
#
# macOS: Compiles create-mirror (CoreAudio aggregate device helper)
# Linux/Windows: No native binaries needed (uses system APIs directly)
#

set -euo pipefail

AUDIO_DARWIN_DIR="pkg/rancher-desktop/main/audio-driver/platform/darwin"

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[audio-native] Building native binaries for macOS..."

  if [[ -f "$AUDIO_DARWIN_DIR/create-mirror.c" ]]; then
    clang \
      -framework CoreAudio \
      -framework AudioToolbox \
      -framework CoreFoundation \
      -o "$AUDIO_DARWIN_DIR/create-mirror" \
      "$AUDIO_DARWIN_DIR/create-mirror.c"
    echo "[audio-native] create-mirror compiled successfully"
  else
    echo "[audio-native] create-mirror.c not found — skipping"
  fi

  if [[ -f "$AUDIO_DARWIN_DIR/capture-loopback.cpp" ]]; then
    clang++ -std=c++17 -O2 \
      -framework CoreAudio \
      -framework AudioToolbox \
      -framework CoreFoundation \
      -o "$AUDIO_DARWIN_DIR/capture-loopback" \
      "$AUDIO_DARWIN_DIR/capture-loopback.cpp"
    echo "[audio-native] capture-loopback compiled successfully"
  else
    echo "[audio-native] capture-loopback.cpp not found — skipping"
  fi
else
  echo "[audio-native] Not macOS — skipping native audio build"
fi
