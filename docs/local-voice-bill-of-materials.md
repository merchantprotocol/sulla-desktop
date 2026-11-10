# Local Voice: Bill of Materials and Pinned Models (Phase 0)

**Status:** Research complete, pins proposed. No runtime code changed.
**Date:** 2026-11-10
**Owner:** Codex LUNA Worker (for Coding Manager)
**Companion manifest:** `pkg/sulla-desktop/main/voice/models/voice-model-manifest.json`
**Plan it implements:** `REPORT-XPLAT.md` (onnxruntime-node in an Electron utility process, CPU mandatory, Smart Turn for end-of-turn, Silero or TEN VAD, Kokoro or Pocket TTS).

Scope: packages, model weights, licenses and pinned artifacts for the fully local voice stack. Targets: macOS arm64 and x64, Windows x64 and arm64, Linux x64 and arm64. Tier 1 is an 8 GB, CPU-only machine.

---

## 0. Summary

| Component | Pinned default (Tier 1) | Why | Blocker or gap |
|---|---|---|---|
| Runtime | `onnxruntime-node` **1.23.0** (MIT) | Newest release I found with prebuilt bindings for all six tuples. N-API v6. | **Latest is 1.31.1, but it has no darwin-x64 binding.** Intel Mac would fail. |
| End of turn | Smart Turn v3.2 CPU ONNX (BSD-2-Clause) | Small, permissive, upstream-documented CPU path. | Benchmarked only as a component (M4). Intel not measured. |
| VAD | Silero VAD ONNX (MIT) | Permissive. TEN VAD has conditions that restrict competing deployments. | None known. |
| STT (chunked) | Whisper tiny, quantized ONNX (Apache-2.0 repo tag; OpenAI weights MIT) | Runs on the same ORT as the rest. | Not streaming. Partial results need a rolling-window design. |
| STT (streaming, alternate) | sherpa-onnx Zipformer EN int8 (Apache-2.0) | True streaming. | Needs `sherpa-onnx-node`. The 1.13.8 pin has no win32-arm64 dependency. Bundles its own ORT. |
| TTS | Kokoro-82M v1.0 ONNX, 8-bit (Apache-2.0) + `af_heart` voice | Official weights, no gating, 92 MB. | Not benchmarked on any target. |
| TTS (alternate) | Pocket TTS ONNX int8 (CC-BY-4.0 models, community export) | Measured fast in PyTorch on the M4. | Only ONNX is third-party. Voice cloning and per-voice licenses. Gated upstream. |

**Blockers found**
1. `onnxruntime-node` latest (1.31.1) has no `darwin/x64` binding. This is verified from the tarball. Pin 1.23.0 or ship a different Intel Mac path.
2. `sherpa-onnx-node` 1.13.8, the version declared in `package.json`, does not list `sherpa-onnx-win-arm64` in its `optionalDependencies`. Windows arm64 would not get the native addon. Version 2.0.1 does list it.
3. TEN VAD license: its additional conditions forbid deploying "in a way that competes with Agora's offerings". Not used as the default.
4. No GPL or non-commercial model weights in the defaults. Every default is permissive. CC-BY-4.0 on Pocket requires attribution, and its voice files carry separate per-voice terms.

---

## 1a. Runtime matrix

Method: npm packuments read from `registry.npmjs.org`. Native binding lists read from the downloaded `.tgz` file lists (`tar -tzf`). Nothing here comes from a marketing page.

### onnxruntime-node

| Version | Published | License | N-API | darwin-arm64 | darwin-x64 | win32-x64 | win32-arm64 | linux-x64 | linux-arm64 | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| **1.31.1** (latest) | 2026-10-26 | MIT | v6 | yes | **NO** | yes | yes | yes | yes | Verified |
| 1.30.0 | (packument) | MIT | v6 | yes | **NO** | yes | yes | yes | yes | Verified |
| 1.26.0 | (packument) | MIT | v6 | yes | **NO** | yes | yes | yes | yes | Verified |
| **1.23.0** (pinned) | (packument) | MIT | v6 | yes | yes | yes | yes | yes | yes | Verified |
| 1.22.0 | 2025-05-09 | MIT | v6 | yes | yes | yes | yes | yes | yes | Verified |

- Binding layout is `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`, plus the bundled ORT shared library for that platform (Verified in tarball).
- `script/install-metadata.js` in 1.31.1 maps `darwin/x64` to an empty manifest. The binding is not shipped (Verified).
- Version 1.24.0 is not on the registry (404). I did not check 1.25.x. Pinning 1.23.0 is therefore "newest verified six-tuple release", not "newest possible six-tuple release".
- `linux/x64` lists an optional `cuda12` GPU manifest. CPU does not need it (Verified in `install-metadata.js`).
- **Electron:** N-API v6 means the binding does not need an Electron ABI rebuild. This is verified from the manifest and file names. It is not verified by loading the module inside an Electron build.

### sherpa-onnx-node

| Version | License | optionalDependencies covering the six tuples | Declared in repo | Status |
|---|---|---|---|---|
| 1.13.8 | Apache-2.0 | darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64, win-ia32. **Missing win-arm64.** | `package.json` `"sherpa-onnx-node": "1.13.8"` | Verified from packument |
| **2.0.1** (latest, 2026-10-26) | Apache-2.0 | darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64, win-arm64, win-ia32 | no | Verified from packument |

Per-tuple packages (`sherpa-onnx-<tuple>`), both versions have a tarball with a native `sherpa-onnx.node` (Verified):

| Tuple | 1.13.8 | 2.0.1 |
|---|---|---|
| darwin-arm64 | yes | yes |
| darwin-x64 | yes | yes |
| linux-x64 | yes | yes |
| linux-arm64 | yes | yes |
| win32-x64 | yes | yes |
| win32-arm64 | yes (exists, but the parent does not depend on it) | yes |

- Each per-tuple package also ships its own ONNX Runtime (`libonnxruntime.dylib` / `.so`, or `onnxruntime.dll`). The bundled library reports `libonnxruntime.so.1.28.2` in `strings` for both 1.13.8 and 2.0.1 (Verified by `strings`, not run).
- **Electron:** `sherpa-onnx.node` exports 140 (1.13.8) and 146 (2.0.1) `napi_*` symbols. That points to an N-API addon, so no ABI rebuild is needed. Not run inside Electron (Verified by symbol table only).
- **Duplicate runtime risk:** if sherpa and onnxruntime-node load in the same process, two ORT copies are present. On Windows both packages ship a file named `onnxruntime.dll` (Verified by file list). Test loader behavior before using both. This is the main reason the plan prefers a single ORT.

### Other JS packages considered

| Package | Version | License | Dependency note | Use |
|---|---|---|---|---|
| `kokoro-js` | 1.2.1 (2025-05-03) | Apache-2.0 | depends on `@huggingface/transformers ^3.5.1` (Verified) | Not chosen. Adds a second ORT path and an older version. |
| `@huggingface/transformers` | 4.3.2 (2026-10-27) | Apache-2.0 | depends on `onnxruntime-node` **1.30.0** (Verified) | Not chosen. Pulls an ORT version with no darwin-x64 binding. |

Neither is needed. The Kokoro and Whisper ONNX files can be run directly with `onnxruntime-node`, plus a small tokenizer and feature extractor we write.

---

## 1b. Model matrix (pinned artifacts)

Labels:
- **Verified**: I downloaded the file into scratch, computed sha256 and size, and where HF publishes an LFS OID, the hash matched it. Downloads were done only in `/mnt/worktrees/_scratch/docs-voice-p0-bom/` and are deleted at cleanup.
- **Upstream-claimed**: taken from the model card, README or repo tags. Not downloaded or checked.

Revisions are the HF commit SHA read from the repo API, so each URL is immutable.

### Defaults (in the manifest)

| Component | Artifact (HF repo @ revision) | Size (bytes) | sha256 | Weights license | Redistribution / commercial | Sample rate / format | Label |
|---|---|---|---|---|---|---|---|
| End of turn | `pipecat-ai/smart-turn-v3` @ `f766f81d3cfdf7737ac64aad813d91bbfd56bf93` `smart-turn-v3.2-cpu.onnx` | 8,679,182 | `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` | BSD-2-Clause (repo `license` tag, README) | Permissive, commercial OK, keep notice | 16 kHz input, raw waveform (upstream) | sha/size **Verified**; int8 and 16 kHz **Upstream-claimed** (README says "8 MB ONNX (int8 quantized)") |
| VAD | `onnx-community/silero-vad` @ `e71cae966052b992a7eca6b17738916ce0eca4ec` `onnx/model.onnx` | 2,243,022 | `a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808` | MIT (`LICENSE` in repo, "Silero Team") | Permissive, commercial OK, keep notice | 16 kHz (upstream) | sha/size/LFS **Verified**; 16 kHz **Upstream-claimed**. Conversion repo; upstream is `snakers4/silero-vad`. |
| STT encoder | `Xenova/whisper-tiny` @ `5332fcc35e32a33b86612b9a57a89be7906102b1` `onnx/encoder_model_quantized.onnx` | 10,124,910 | `fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e` | Apache-2.0 (repo tag). OpenAI Whisper weights are MIT upstream. | Permissive, commercial OK | 16 kHz log-mel (Whisper spec) | sha/size/LFS **Verified**; "quantized" meaning and 16 kHz **Upstream-claimed** |
| STT decoder | same repo `onnx/decoder_model_merged_quantized.onnx` | 30,727,765 | `6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0` | same | same | n/a | sha/size/LFS **Verified** |
| STT tokenizer | same repo `tokenizer.json` | 2,480,466 | `27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566` | same | same | n/a | sha/size **Verified** |
| STT preprocessor | same repo `preprocessor_config.json` | 339 | `a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d` | same | same | feature-extractor config | sha/size **Verified** |
| TTS model | `onnx-community/Kokoro-82M-v1.0-ONNX` @ `1939ad2a8e416c0acfeecc08a694d14ef25f2231` `onnx/model_quantized.onnx` | 92,361,116 | `fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478` | Apache-2.0 (repo tag) | Permissive, commercial OK | output 24 kHz (repo example writes 24000) | sha/size/LFS **Verified**; 24 kHz **Upstream-claimed** (code sample) |
| TTS voice | same repo `voices/af_heart.bin` | 522,240 | `d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b` | Apache-2.0 (repo tag). Per-voice data provenance not reviewed. | see open risks | style vector for output | sha/size/LFS **Verified** |
| TTS config | same repo `config.json` | 44 | `df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f` | Apache-2.0 (repo tag) | same | n/a | sha/size **Verified** |

Total default download: **147,139,084 bytes** (about 140 MiB).

### Alternates (documented, not in the default manifest)

| Component | Artifact | Size (bytes) | sha256 | License | Label / notes |
|---|---|---|---|---|---|
| STT streaming | `csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26` @ `672fbf1b30579d6585301139bb363f42a0ad4a24`: `encoder-…-chunk-16-left-64.int8.onnx` | 71,082,637 | `0d072fd4ef956294ba9db9e9a71a541ac70659095ec4934c8453d8b2fe740187` | Apache-2.0 (repo tag) | Verified (sha + LFS). Needs sherpa-onnx at runtime. |
| same | `decoder-…-left-64.int8.onnx` | 1,307,236 | `98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02` | same | Verified |
| same | `joiner-…-left-64.int8.onnx` | 259,335 | `d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297` | same | Verified |
| same | `tokens.txt` | 5,048 | `49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb` | same | Verified |
| same | `bpe.model` | 244,865 | `c53433de083c4a6ad12d034550ef22de68cec62c4f58932a7b6b8b2f1e743fa5` | same | Verified |
| VAD alternate | TEN VAD `TEN-framework/ten-vad` @ `bda8ffc78b1846c5c7cbd38f04e52deff49de707` `src/onnx_model/ten-vad.onnx` | 315,449 | `e10b98a0cab1c98e847fbdda14cb3d45a38336d47535a3f63a0fb6c4e0f4cdf4` | **Apache-2.0 plus additional conditions** (see open risks) | Verified sha. 16 kHz, hop 160/256 (README). **Not selected.** |
| TTS alternate | `KevinAHM/pocket-tts-onnx` @ `58a6d00cf13d239b6748cb0769f35c580a8f606c` `onnx/english_2026-04/` int8 bundle: `flow_lm_flow_int8.onnx` (9,962,530), `flow_lm_main_int8.onnx` (76,341,079), `mimi_decoder_int8.onnx` (22,684,077), `mimi_encoder_int8.onnx` (20,779,616), `text_conditioner_int8.onnx` (16,388,384) | 146,155,686 total | `3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d`, `f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116`, `3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925`, `abb46f1ad0b83c3840fe38c3652ab0eda7d1d97a63f1953bbbff5d04d8f4c855`, `24c0642bff11a4e1435c004d0c2aa6c68e093fadfa35f0f0dba849ac67f25ac3` | **CC-BY-4.0** models (inherited from `kyutai/pocket-tts`). Code Apache-2.0. Upstream repo is gated. Voice cloning carries a prohibited-use clause. | sha/size/LFS **Verified** for the five int8 files. The export is third-party; Kyutai publishes safetensors, not ONNX. Its README says "Pocket TTS ... 24 kHz" (Upstream-claimed); our bench on the M4 measured 24 kHz WAV output (Measured, PyTorch, not ONNX). Voice embeddings are separate per-voice files under `kyutai/tts-voices` with their own licenses. |

### Existing pins in the repo (for reconciliation)

| Where | What | Notes |
|---|---|---|
| `pkg/sulla-desktop/main/voice/kokoroTts.ts` (`MODEL`) | sherpa-onnx release `kokoro-multi-lang-v1_0.tar.bz2`, 349,886,476 bytes, sha256 `60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4` | Repo-declared. **Not re-downloaded here.** Ships a full-precision `model.onnx` plus `voices.bin`, so it is about 3.8x the 8-bit default. This is the existing desktop Kokoro path, through `sherpa-onnx-node`. Decision: migrate to the 8-bit ORT pin or keep sherpa. See the recommendation. |
| `scripts/fetch-bundled-assets.ts` (`WHISPER_MODEL`) | whisper.cpp `ggml-base.en.bin` @ `5359861c739e955e79d9a303bcbc70fb988958b1`, sha256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` | Repo-declared. ggml format for whisper.cpp, not ONNX. Used by the audio driver. Not part of the ONNX stack. |
| `pkg/sulla-desktop/main/audio-driver/platform/{darwin,linux}` | whisper.cpp `ggml-*.bin` from HF `main` branch (not pinned to a commit) | Unpinned revision. Flag for a separate fix. |

---

## 2. Recommended pinned default per component (Tier 1, 8 GB CPU)

1. **Runtime: `onnxruntime-node` 1.23.0.** It is the newest release I verified with bindings for all six tuples, MIT, N-API v6. It runs CPU by default, with no GPU requirement. 1.31.1 is the latest but has no darwin-x64 binding, so it cannot cover Intel Mac. Move to a newer pin only after confirming darwin-x64 is back.
2. **End of turn: Smart Turn v3.2 CPU ONNX.** Small (8.7 MB), BSD-2-Clause, and it was the best-measured component on the M4 in our bench (median ~120–220 ms on 2–8 s clips, RSS ~172 MiB).
3. **VAD: Silero VAD ONNX (fp32 `model.onnx`, 2.2 MB).** MIT with no added terms. The fp32 file is kept for fidelity. The `model_quantized.onnx` (639 KB) is a drop-in if RAM is tight. TEN VAD is excluded because of its competitive-deployment clause.
4. **STT: Whisper tiny, quantized ONNX (encoder 10.1 MB + decoder 30.7 MB).** It runs on the same ORT as everything else. The M4 bench gave ~120 ms warm for 2.5 s clips, but that was MLX, not ONNX, and the ORT path is untested. This is chunked, not streaming. Partial results need a rolling window. Sherpa Zipformer is the streaming upgrade once the runtime question is settled.
5. **TTS: Kokoro-82M v1.0 8-bit ONNX + `af_heart` voice (92 MB + 0.5 MB).** Apache-2.0 weights from the official author, no gating, ships ONNX. Pocket TTS was faster in our PyTorch bench (first chunk median ~156 ms, RTF 0.5), but its only ONNX is third-party, its voices carry separate terms, and its prohibited-use clause concerns cloning. Keep Pocket as an evaluated alternate until an ONNX parity test passes.

**Not benchmarked on any target**, so these defaults are provisional until the Phase 2–5 harness runs. No model has an RTF or RSS figure from ONNX on Electron. The Intel Mac and Windows/Linux arm64 cases are unmeasured.

---

## 3. Open risks

- **Intel Mac (darwin-x64).** `onnxruntime-node` ≥1.26 has no darwin-x64 binding. Pinning 1.23.0 keeps Intel Mac, but it is 8 minor releases behind latest. Versions 1.24–1.25 were not checked. Alternate path: use sherpa 2.0.1's darwin-x64 package, which bundles its own ORT. That reintroduces a second runtime.
- **Two ORT copies.** Sherpa per-tuple packages bundle ORT 1.28.2 (per `strings`). `onnxruntime-node` 1.23.0 bundles its own. Loading both in one process is untested and risky, especially on Windows (both ship `onnxruntime.dll`).
- **Windows arm64 with sherpa 1.13.8.** Parent `optionalDependencies` omit `sherpa-onnx-win-arm64`. A fresh install on Windows arm64 gets no addon. Either bump to 2.0.1 or drop the sherpa dependency.
- **Linux arm64.** ORT 1.23.0 ships `linux/arm64`. Verified at the file level only. Not run.
- **Electron ABI.** N-API is the reason no rebuild is expected. None of this is verified inside an Electron build.
- **Code and weights can differ.** Smart Turn, Silero and Kokoro weights are permissive. Whisper weights are MIT upstream but the converted repo is tagged Apache-2.0. Keep both notices.
- **Kokoro voice provenance.** `af_heart` is Apache-2.0 per the repo tag. I did not review the source data for each voice pack. Before shipping, check the voice's model card.
- **Pocket TTS.** Gated upstream, with CC-BY-4.0 model terms and a prohibited-use clause against voice cloning without consent. Individual voices have their own terms. Do not ship a cloning-capable voice. The ONNX export is third-party and unverified for parity.
- **TEN VAD.** Excluded. Its license forbids deploying in ways that compete with Agora's offerings.
- **Repo drift.** `kokoroTts.ts` pins a full-precision sherpa Kokoro archive (~350 MB). Our default is an 8-bit ORT model (~92 MB). Pick one and migrate the other.
- **Streaming.** No validated streaming STT yet. Whisper here is chunked.
- **Unmeasured.** Peak RSS, RTF and first-audio latency on the 8 GB target, on all six tuples, through Electron with these ONNX models. These are the Phase 2–5 gates.

---

## 4. Manifest

`pkg/sulla-desktop/main/voice/models/voice-model-manifest.json` lists the nine default artifacts. Fields: `id`, `component`, `url`, `revision`, `sha256`, `sizeBytes`, `license`, `sampleRate`, plus a `sampleRateNote`.

Why this folder: it sits next to `kokoroTts.ts` and the rest of `main/voice`, which is where the main process reads voice data. A future `ModelRepository` can import it from there. Weights are never committed. The manifest holds only URLs and hashes.

## 5. How the hashes were produced

```
curl -fL https://huggingface.co/<repo>/resolve/<revision>/<path> -o <file>
sha256sum <file>
```

The result was checked against the LFS OID in the HF tree API for each LFS file (`api/tree_*.json`). Files that are not LFS (`config.json`, `tokenizer.json`, `preprocessor_config.json`, `LICENSE`) have no OID to compare, so their hashes are only recorded.

Downloads were removed at cleanup. Nothing from the scratch folder is kept in the repo.
