#!/usr/bin/env bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

#
# Build native audio-driver binaries for the current platform.
# Called automatically by `yarn build` before the main build step.
#
# macOS: Compiles create-mirror, capture-loopback and the Swift CoreAudio helpers
# Linux/Windows: No native binaries needed (uses system APIs directly)
#

set -euo pipefail

AUDIO_DARWIN_DIR="pkg/sulla-desktop/main/audio-driver/platform/darwin"

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "[audio-native] Building native binaries for macOS..."

  AUDIO_NATIVE_WORK="$(mktemp -d "${TMPDIR:-/tmp}/sulla-audio-native.XXXXXX")"
  trap 'rm -rf "$AUDIO_NATIVE_WORK"' EXIT

  build_universal_binary() {
    local compiler="$1" output="$2" source="$3"
    shift 3

    "$compiler" "$@" -target arm64-apple-macos11 \
      -o "$AUDIO_NATIVE_WORK/arm64-$(basename "$output")" "$source"
    "$compiler" "$@" -target x86_64-apple-macos11 \
      -o "$AUDIO_NATIVE_WORK/x86_64-$(basename "$output")" "$source"
    lipo -create \
      "$AUDIO_NATIVE_WORK/arm64-$(basename "$output")" \
      "$AUDIO_NATIVE_WORK/x86_64-$(basename "$output")" \
      -output "$output"
  }

  if [[ -f "$AUDIO_DARWIN_DIR/create-mirror.c" ]]; then
    build_universal_binary clang "$AUDIO_DARWIN_DIR/create-mirror" "$AUDIO_DARWIN_DIR/create-mirror.c" \
      -framework CoreAudio \
      -framework AudioToolbox \
      -framework CoreFoundation
    echo "[audio-native] create-mirror compiled successfully"
  else
    echo "[audio-native] create-mirror.c not found — skipping"
  fi

  if [[ -f "$AUDIO_DARWIN_DIR/capture-loopback.cpp" ]]; then
    build_universal_binary clang++ "$AUDIO_DARWIN_DIR/capture-loopback" "$AUDIO_DARWIN_DIR/capture-loopback.cpp" \
      -std=c++17 -O2 \
      -framework CoreAudio \
      -framework AudioToolbox \
      -framework CoreFoundation
    echo "[audio-native] capture-loopback compiled successfully"
  else
    echo "[audio-native] capture-loopback.cpp not found — skipping"
  fi

  # Compile the Swift CoreAudio helpers ahead of time. Running them as
  # scripts (`swift file.swift`) needs the Xcode command line tools on the
  # user's Mac, which macOS would offer to download on first use.
  SWIFT_HELPERS="detect-loopback create-multi-output watch-output set-system-device reset-default-output volume-control"
  for helper in $SWIFT_HELPERS; do
    build_universal_binary swiftc "$AUDIO_DARWIN_DIR/$helper" "$AUDIO_DARWIN_DIR/$helper.swift" \
      -O -suppress-warnings
  done
  echo "[audio-native] Swift helpers compiled successfully"

  # Stage scripts + binaries into resources/darwin/audio-driver/ so
  # electron-builder's extraResources picks them up. The runtime resolves
  # them via paths.resources (see platform/darwin/index.ts); resources/darwin
  # is gitignored, so without this step packaged builds ship no audio assets.
  STAGE_DIR="resources/darwin/audio-driver"
  mkdir -p "$STAGE_DIR"
  cp "$AUDIO_DARWIN_DIR"/*.swift "$STAGE_DIR/"
  for bin in create-mirror capture-loopback $SWIFT_HELPERS; do
    if [[ -f "$AUDIO_DARWIN_DIR/$bin" ]]; then
      cp "$AUDIO_DARWIN_DIR/$bin" "$STAGE_DIR/"
      chmod +x "$STAGE_DIR/$bin"
    fi
  done
  echo "[audio-native] Staged audio-driver assets into $STAGE_DIR"
else
  echo "[audio-native] Not macOS — skipping native audio build"
fi
