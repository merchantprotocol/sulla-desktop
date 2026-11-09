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
