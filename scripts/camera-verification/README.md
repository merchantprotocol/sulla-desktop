<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# CE-1 actual-parent verification

This is a **scripts-only composition**, not a shipping mode or a full installed app.
Production has no environment/argv/IPC switch selecting these fixtures.

Dispatch `agent-tests.yml` on the PR branch with `ce1_full_verification: true` and
`expected_sha` equal to the complete current 40-character commit SHA. CI rejects
any different checkout. All compilation, tests and mutation execution happen on
the remote runner. Do not install/build/test this locally.

## Two different graphs

1. `compile.ts` resolves the existing Vue CLI configuration in production mode,
   selects the original capture-studio page, and compiles its original entry,
   complete parent, shared host and personal startup graph. It separately uses
   the existing build-utils production main/preload configs. **Those outputs are
   compiled, never launched.** No aliases/stubs are applied to these graphs.
2. A second renderer compilation uses the same loaders/template but a
   `scripts/camera-verification/entry.ts` composition and an explicit isolated
   paths module. It installs synthetic media before importing the real
   CaptureStudioWindow/complete CaptureStudio.vue. Real production menu,
   CameraStreamService, effects (native pinned WASM/model), recorder and native
   filesystem writer are retained. No parent source extraction or replacement.
   Runtime stats must contain the actual parent and must exclude personal startup.

## Boundaries

- Production startup adapters delegate to the existing initiateWindowContext,
  store, plugins, native loader and model reader. Only dependency composition
  moves; no product feature or security setting is changed.
- The scripts host replaces shared store/plugins and unrelated audio services.
  Settings are a strict in-memory repository with enumerated keys. Actual IPC
  transport is retained; unknown invoke/send is fatal, not delegated.
- Synthetic media replaces enumeration and every getUserMedia call before
  imports/boot, including label enumeration and the parent's automatic mic path.
- HOME/XDG/profile/session/recording paths use ephemeral runner directories.
  Kernel network namespace blocks Node/native as well as Chromium network.
  Chromium rejects permissions and outbound URLs. Dependency download precedes
  network isolation. No production background/bootstrap process is launched.
- Existing Capture Studio BrowserWindow preferences are matched, not weakened.
  CI-only software rendering/no-sandbox flags are not shipping flags.

## Evidence and limits

Trusted Electron pointer events drive video right-click menus/flyouts and the
actual parent's controls. Read-only JavaScript observes readiness/pixels; a
scripts-only Vue observer retains an actual menu action solely to test rejection
when invoked after the recording lock. A one-shot injected model-reader failure
exercises fallback/retry, without replacing inference during successful sessions.
The native model/WASM smoke and existing regression mutants remain separate gates.

Always-upload artifacts include separate graph stats, runtime bundle identities,
nonempty screenshots, actual parent camera.webm, decoded PNG, pixel sentinels,
fixture/IPC/network/permission audit and runtime SHA metadata. A compile failure
is **not** a runtime pass; absent screenshots/WebM mean the actual parent gate
has not run successfully.

Excluded: production background/personal startup execution, shared store/plugins
in the runtime composition, native audio drivers, installed packaging, signing,
notarization/release, real camera/mic, macOS permission behavior and hardware
quality/performance/FPS. No merge or release authorization is implied.
