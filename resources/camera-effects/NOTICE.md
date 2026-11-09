# Offline camera-effects assets

Google MediaPipe Tasks Vision 0.10.21 and Selfie Multiclass 256x256,
float32 version 1. Copyright Google LLC. Distributed under Apache-2.0;
see LICENSE. Upstream: https://github.com/google-ai-edge/mediapipe

The model's labels (background, hair, body-skin, face-skin, clothes, others)
are documented at https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
The model is person segmentation, NOT identity recognition. No face embeddings
are generated. Largest connected foreground silhouette supplies framing;
only category 3 (face skin) receives appearance softening.

manifest.json pins original URLs, npm tarball SHA-512 and extracted file SHA-256.
Both SIMD and non-SIMD WASM variants are bundled. No npm dependency/lockfile
change or runtime download is needed. electron-builder's existing resources/
extraResources rule copies this directory unchanged outside app.asar.

The application adapter accepts the absolute directory under paths.resources
(camera-effects). It converts local assets to file URLs for MediaPipe.
Packaged Electron CPU/WASM loading, CSP and target-device performance must
be verified before UI integration/activation. Do not substitute remote URLs
if a local load fails. Do not claim measured frame rates without a device test.

Assets downloaded byte-for-byte from the manifest URLs; npm tarball integrity
verified against registry dist.integrity before extraction. Original upstream
README.md preserved. Only an Apache-2.0 SPDX comment was prepended to JavaScript assets for the repository license scanner; distributedFiles records those hashes, files records original hashes.

Third-party runtime lives in vendor/, the architecture guard's existing vendor exclusion. Application business logic remains fully scanned; no allowlist or guard change.

## Exact redistribution edits / static packaging evidence

The only edits to upstream JavaScript are the exact 39 ASCII bytes
`// SPDX-License-Identifier: Apache-2.0
` prepended to:
- vision_bundle.cjs -> vendor/vision_bundle.cjs
- wasm/vision_wasm_internal.js -> vendor/wasm/vision_wasm_internal.js
- wasm/vision_wasm_nosimd_internal.js -> vendor/wasm/vision_wasm_nosimd_internal.js

No other bytes were edited. WASM/model bytes remain unchanged.
manifest.files hashes upstream tar member bytes; manifest.distributedFiles
hashes on-disk shipped bytes including the SPDX prefix and vendor path.
The Apache license was fetched from the upstream v0.10.21 LICENSE URL.

Static evidence, NOT runtime proof:
- pkg/sulla-desktop/vue.config.mjs sets target electron-renderer.
- pkg/sulla-desktop/window/index.ts Capture Studio webPreferences enables
  nodeIntegration and disables contextIsolation. This change does not alter it.
- utils/paths.ts resolves packaged resources (including nested resources/).
- packaging/electron-builder.yml extraResources includes resources/.
- OfflinePersonInference requires an injected native runtime loader; the later
  composition root must pass Electron's native require, NOT webpack require.
  The default createRequire loader was removed to avoid webpack rewriting a
  dynamic module path before renderer integration. No dynamic module import
  is bundled in this core. The adapter passes only local file URLs to MediaPipe.
- No renderer build or packaged execution was permitted; native loader binding,
  file:// fetch/WASM script loading, CSP and model compatibility remain an
  explicit integration gate, not a verified capability.
