<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# CE-1: optional local camera processing (integration gated)

Epic base: main aec0bb258. Core sub-PR targets epic/camera-effects.
No UI, camera acquisition or recorder wiring is authorized in this change.
All controls remain absent/off until design approval and packaged runtime proof.

The core exposes VideoEffectService.open(raw, options), yielding one session.stream
for BOTH preview and recording. The caller owns raw tracks. Closing a session
stops only its canvas tracks, detaches its video and closes its model. Construct
OfflinePersonInference with paths.resources/camera-effects; use a fresh instance
and BrowserFrameSurface per session. Disabled sessions return raw unchanged;
to enable a session opened entirely disabled, reopen it before recording.

Inference is serial, at most once per 66 ms, with no pending frame queue. Framing
tracks the largest connected segmented person with time-based smoothing and
bounded 1.25x crop. Softening applies only to model face-skin labels, at most
35% of a 1.5px blur. Background blur is bounded at 12px. No identification,
uploads, telemetry or runtime CDN. Assets are pinned under resources/camera-effects
and included through the existing electron-builder extraResources rule.

Initialization failure returns raw and reports an error. Mid-stream inference
failure keeps the same output track alive while drawing raw frames. No silent
claim that effects are still active. Consumer must display/report failures and
release the session on source switch, track end, window teardown and cancellation.

Before integration: approve UI; prove file:// model/WASM loading under packaged
Electron CSP; exercise no-person/multiple-person/low-light scenes and diverse
skin/hair; verify real video pixels, resource cleanup and sustained CPU/latency
on target hardware. No measured quality/performance claim is made by this PR.
No tests, installs, typecheck, lint or build are run locally per task restriction;
CI results must be reviewed separately. Undo by reverting the core sub-PR and
this epic document, preserving independent speaker-audio work.
