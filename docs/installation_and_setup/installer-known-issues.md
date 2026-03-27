# Installer Known Issues & Solutions

This document catalogs every significant installer failure we've encountered, what caused it, and how the current modular installer architecture addresses it. It exists so future contributors don't repeat these mistakes and can quickly diagnose regressions.

The installer was rewritten from a 1610-line monolithic bash script into a modular OOP-style architecture in March 2026 (PR #259). Each OS has its own isolated module (`macos::`, `linux::`, `windows::`), failures are caught immediately via assertions, and the build pipeline is fully separated from dependency installation.

---

## Table of Contents

1. [rdctl EBADARCH on Apple Silicon](#1-rdctl-ebadarch-on-apple-silicon)
2. [node-gyp Missing on Linux](#2-node-gyp-missing-on-linux)
3. [PATH Not Bootstrapped — Tools Not Found](#3-path-not-bootstrapped--tools-not-found)
4. [limactl Missing After Install](#4-limactl-missing-after-install)
5. [run_with_status Hanging After Build Completes](#5-run_with_status-hanging-after-build-completes)
6. [Xcode CLT Stub State](#6-xcode-clt-stub-state)
7. [sudo Prompts Swallowed by Spinners](#7-sudo-prompts-swallowed-by-spinners)
8. [Dependencies Not Found on Repeat Runs](#8-dependencies-not-found-on-repeat-runs)
9. [Verification Checking Wrong Artifacts at Wrong Phase](#9-verification-checking-wrong-artifacts-at-wrong-phase)
10. [Nightly Installs Using Stale Cached Builds](#10-nightly-installs-using-stale-cached-builds)
11. [Install Directory Safety / rm -rf Guards](#11-install-directory-safety--rm--rf-guards)
12. [yarn install Failure from sqlite-vec Platform Check](#12-yarn-install-failure-from-sqlite-vec-platform-check)
13. [Orphaned Spinner Processes](#13-orphaned-spinner-processes)
14. [ENOENT uv_cwd Crash](#14-enoent-uv_cwd-crash)
15. [postinstall Downloads Silently Failing](#15-postinstall-downloads-silently-failing)
16. [Verification Returned Silently on First Failure](#16-verification-returned-silently-on-first-failure)
17. [node-pty spawn-helper Permissions](#17-node-pty-spawn-helper-permissions)
18. [GitHub Connectivity Not Checked Until Clone](#18-github-connectivity-not-checked-until-clone)

---

## 1. rdctl EBADARCH on Apple Silicon

**PRs:** #207, #208

**Symptom:** The app installed successfully but crashed on launch. Electron failed to spawn `rdctl` with error code -86 (EBADARCH).

**Root cause:** `install-dev.sh` never exported `M1=true` on ARM machines. `postinstall.ts` read `process.env.M1` to decide the Go cross-compilation target, defaulted to `amd64`, and produced an x86_64 binary that macOS refused to execute on Apple Silicon.

**What we tried:**
- First fix: Export `M1=true` in `install-dev.sh` when `uname -m` reports `arm64` or `aarch64`
- Second fix: Also detect ARM natively in `postinstall.ts` via `process.arch` so it works without the env var (IDE builds, manual `yarn install`)
- Third fix: Add rdctl to `verify_build_artifacts` with an execution smoke-test so arch mismatches fail the build step instead of silently passing

**Current solution (modular installer):**
- `macos::preflight()` in `10-os-macos.sh` exports `M1=true` for ARM architectures
- `macos::verify_platform_binaries()` calls `assert_executable_runs` on rdctl, which executes the binary AND includes `file()` output in the error message if it fails — so you see exactly what architecture the binary was compiled for

---

## 2. node-gyp Missing on Linux

**PRs:** #205, #206

**Symptom:** `yarn install` failed on fresh Linux machines with errors about `node-gyp` not being found during `node-pty` compilation.

**Root cause:** `node-pty@1.1.0` ships no prebuilds for `linux-x64` and falls back to `node-gyp rebuild`. On a fresh install, `node-gyp` is a devDependency resolved later in the dependency tree — it's not in PATH when node-pty's install script runs.

**What we tried:**
- Install `node-gyp` globally via `npm install -g node-gyp` on Linux before `yarn install`

**Current solution:**
- `linux::pre_yarn_install()` in `11-os-linux.sh` checks for node-gyp and installs it globally if missing. This is called via `dispatch_optional pre_yarn_install` before `yarn install` runs.
- macOS and Windows don't need this (prebuilds exist for those platforms).

---

## 3. PATH Not Bootstrapped — Tools Not Found

**PRs:** #205, #215

**Symptom:** `yarn install` or `yarn build` failed with ENOENT for `gofmt`, `go`, or `git` — tools that were installed but not in PATH.

**Root cause:** When `install-dev.sh` is piped from curl (`curl ... | bash`), it runs in a non-interactive shell with a minimal PATH. Tools installed by Homebrew (Apple Silicon: `/opt/homebrew/bin`, Intel: `/usr/local/bin`), Linuxbrew, or Go (`/usr/local/go/bin`) were invisible. Node subprocesses during `yarn install`/`yarn build` (which call `gofmt`, `git describe`, etc.) inherited this broken PATH.

**What we tried:**
- Added `bootstrap_path()` that pre-populates PATH with all well-known binary locations
- Added `verify_build_path()` gate before yarn install/build to catch missing tools early
- Fixed `generateCliCode.ts` to resolve `gofmt` via GOROOT and well-known paths
- Fixed `postinstall.ts` git describe to fall back to `package.json` version when git is not in PATH

**Current solution:**
- `bootstrap_path()` in `02-platform.sh` adds all known paths (Homebrew ARM/Intel, Linuxbrew, Go, Cargo, MSYS2, system paths)
- Called in `install-dev.sh` bootstrap, and again before every build phase
- `build::verify_prerequisites()` in `40-build.sh` asserts node, yarn, git, go, and gofmt are all in PATH before starting — with a clear error message listing exactly which tools are missing

---

## 4. limactl Missing After Install

**PRs:** #251, #256, #257, #258

**Symptom:** App installed and built "successfully" but crashed on first launch with `spawn ENOENT` for `limactl`. The VM could not start.

**Root cause:** During `postinstall.ts`, the Lima download from GitHub was failing silently due to rate limits (HTTP 403/429). The `verify_install_artifacts()` function only checked `node_modules/.yarn-integrity` and `node_modules/electron/` — it never verified that limactl actually existed. So the installer reported success even though a critical binary was missing.

**What we tried (4 separate PRs):**
1. Added download retry with exponential backoff in `postinstall.ts`, honoring `x-ratelimit-reset` and `Retry-After` headers
2. Fixed the Lima download URL to point to the upstream repo that has actual releases
3. Added diagnostic logging to the Lima download pipeline
4. Added limactl to `verify_install_artifacts()` so the installer re-runs `yarn install` (and postinstall) whenever limactl is absent

**Current solution:**
- `build::verify_platform_binaries()` in `40-build.sh` is a dedicated verification phase that runs AFTER `yarn install` and `yarn build`
- On macOS: `assert_executable` on `resources/darwin/lima/bin/limactl`
- On Linux: `assert_executable` on `resources/linux/lima/bin/limactl`
- If limactl is missing, it's a hard failure with a giant red box — not a silent pass

---

## 5. run_with_status Hanging After Build Completes

**PRs:** #252, #253, #255

**Symptom:** After `yarn build` finished successfully, the installer would sit idle for up to 5 minutes before proceeding to the next step.

**Root cause:** `run_with_status` used process substitution (`<(cmd 2>&1; echo sentinel)`) to capture output. Webpack child processes inherited the pipe file descriptor and kept it open after the main command exited. The `read -t 300` call then blocked for the full 5-minute timeout waiting for pipe EOF that never came.

**What we tried (3 iterations):**
1. **Sentinel detection:** Added `___RWS_EXIT___` sentinel and broke on it inside the loop. Failed because child processes could still hold the fd open before the sentinel was read.
2. **PID polling:** Replaced pipe with background process + `kill -0` PID checking. Failed due to fd inheritance issues with the PID approach.
3. **Done-file approach:** Command runs in subshell writing to a temp file. On exit, writes exit code to a separate "done" file. Main loop polls for the done file's existence. No pipes, no PIDs, no fd inheritance issues.

**Current solution:**
- `run_with_status` in `00-ui.sh` uses the done-file approach (iteration 3). The command writes to a temp file, a separate "done" file signals completion, and the loop polls for file existence.

---

## 6. Xcode CLT Stub State

**PRs:** Early commits (pre-#155)

**Symptom:** On macOS, the installer reported Xcode CLT as installed, but `git` triggered the Xcode install dialog mid-install.

**Root cause:** `xcode-select -p` returns success even when CLT is in a "stub" state — the path exists but the tools aren't actually installed. Running `git` in this state triggers the GUI install dialog.

**What we tried:**
- Replaced `xcode-select -p` with `/usr/bin/xcrun --find clang` which actually verifies the tools work

**Current solution:**
- `macos::audit_deps()` in `10-os-macos.sh` checks BOTH `xcode-select -p` AND `/usr/bin/xcrun --find clang` to confirm tools are functional, not just that the stub path exists.

---

## 7. sudo Prompts Swallowed by Spinners

**PRs:** #155, #156

**Symptom:** Users saw a bare `Password:` prompt (or nothing at all) mid-install with no context about what needed admin access or why.

**Root cause:** Every `sudo` call was wrapped in `run_silent`, which redirected all output (including the password prompt) to the log file. The spinner was also overwriting the line.

**What we tried:**
- Added `require_sudo()` helper that stops the spinner, explains what package needs installing and why, pre-authenticates via `sudo -v`, then lets subsequent `sudo` calls proceed without re-prompting

**Current solution:**
- `require_sudo()` in `00-ui.sh` is called before any sudo operation. It stops the spinner, prints a clear explanation (e.g. "Go 1.24.2 needs to install to /usr/local which requires user authorization"), and pre-authenticates.

---

## 8. Dependencies Not Found on Repeat Runs

**PR:** #158

**Symptom:** Running `install-dev.sh` a second time couldn't find Node, Yarn, or Go that were installed on the first run. The audit showed them as "missing" even though they were installed.

**Root cause:** nvm and fnm shell initialization wasn't being sourced before the dependency audit. On the first run, the installers sourced nvm/fnm internally. On repeat runs, the audit ran without sourcing them first.

**What we tried:**
- Source nvm/fnm and probe Go paths before the audit phase

**Current solution:**
- Each OS module has `_source_node_manager()` and `_find_go()` helper functions called at the start of `audit_deps()`. These source nvm/fnm and check well-known Go paths before any checks run.

---

## 9. Verification Checking Wrong Artifacts at Wrong Phase

**PRs:** #161, #164, #165, #166

**Symptom:** The installer would report failure after `yarn install` because it was checking for `dist/app/background.js` (a build output, not an install output). Or it would skip `yarn install` because it saw stale install artifacts from a previous run.

**Root cause:** A single verification function checked everything — node_modules, dist/, rdctl, limactl — at every phase. Install artifacts and build artifacts were conflated.

**What we tried (4 separate PRs):**
1. Verify by artifacts, not exit codes
2. Remove install retries, add full diagnostic dump on failure
3. Fix install verification to check artifacts at the right phase
4. Fix build verification to only check build outputs

**Current solution:**
Three completely separate verification functions in `40-build.sh`:
- `build::verify_install_artifacts()` — checks `node_modules/.yarn-integrity` and `node_modules/electron/` only. Called after `yarn install`.
- `build::verify_build_artifacts()` — checks `dist/app/background.js` and `dist/app/index.html` only. Called after `yarn build`.
- `build::verify_platform_binaries()` — checks rdctl and limactl via `dispatch verify_platform_binaries`. Called as a separate phase after build.

---

## 10. Nightly Installs Using Stale Cached Builds

**PRs:** #170, #172

**Symptom:** `--nightly` installs used old build artifacts from a previous install instead of rebuilding with the latest code.

**Root cause:** The idempotency check found an existing `dist/` directory and skipped the build entirely, even though the code had been updated to a new commit.

**What we tried:**
- Force-reset to `origin/main` on nightly installs
- Fresh clone every nightly run (no stale build caching)
- Track build ref in `dist/.build-ref`

**Current solution:**
- `build::yarn_build()` in `40-build.sh` reads `dist/.build-ref` and compares it to `$INSTALL_REF`. If the refs differ, the stale build is removed and a full rebuild is triggered.
- `repo::ensure()` in `30-repo.sh` does a fresh clone for nightly when `$USE_NIGHTLY=true`, and `repo::reset_first_run_state()` clears settings so the setup wizard re-runs.

---

## 11. Install Directory Safety / rm -rf Guards

**PR:** #173

**Symptom:** Risk of catastrophic `rm -rf` on the wrong directory during nightly clean installs.

**Root cause:** The `INSTALL_DIR` variable was used in `rm -rf` without safety guards. If it was empty, set to `/`, or set to `$HOME`, the consequences would be devastating.

**What we tried:**
- Added `safe_remove_install_dir()` with multi-layered safety checks

**Current solution:**
- `repo::safe_remove_install_dir()` in `30-repo.sh` checks:
  - Not empty, not `/`, not `$HOME`
  - Must be under `$HOME` (absolute path check)
  - Must contain our repo marker (`package.json` with `sulla-desktop`, or `.git` directory)
  - If none of these are true, it's a hard failure — not a silent skip

---

## 12. yarn install Failure from sqlite-vec Platform Check

**PR:** #175

**Symptom:** `yarn install` failed on macOS because `sqlite-vec` had a win32-specific platform check that errored on other platforms.

**Root cause:** A dependency (sqlite-vec) had platform-specific install logic that didn't handle macOS correctly.

**Current solution:**
- `yarn install --ignore-engines --ignore-platform` flags in `build::yarn_install()` bypass strict platform checks in dependencies.

---

## 13. Orphaned Spinner Processes

**PR:** #181

**Symptom:** If the install failed, spinning animation characters kept appearing on the terminal even after the script exited.

**Root cause:** The spinner runs in a backgrounded subshell. On failure paths, `stop_spinner` wasn't always called before `exit`.

**Current solution:**
- `ui::cleanup()` trap on `EXIT` in `00-ui.sh` kills the spinner and restores the cursor.
- `stop_spinner` is called at every step transition (`step_ok`, `step_fail`, `step_warn`).
- `assert_fail()` in `03-assert.sh` explicitly calls `stop_spinner` and `show_cursor` before printing the error box.

---

## 14. ENOENT uv_cwd Crash

**PR:** #183

**Symptom:** Node crashed with `Error: uv_cwd(): ENOENT` during install.

**Root cause:** `safe_remove_install_dir` deleted the directory while the shell was still `cd`'d into it. Subsequent Node commands failed because the working directory no longer existed.

**Current solution:**
- `repo::ensure()` in `30-repo.sh` always `cd`'s into the new or existing directory after any remove/clone operations, ensuring the working directory always exists.

---

## 15. postinstall Downloads Silently Failing

**PR:** #167

**Symptom:** Binaries like Lima, kubectl, or Docker CLI were missing after install, but the installer reported success.

**Root cause:** `postinstall.ts` caught download errors and continued without re-throwing. No retry logic. No verification of downloaded artifacts.

**What we tried:**
- Added `fetchWithRetry` with exponential backoff in `postinstall.ts`
- Made download failures non-fatal in postinstall but fatal in the installer's verification phase

**Current solution:**
- `postinstall.ts` retries downloads with exponential backoff (honouring `x-ratelimit-reset` and `Retry-After` headers, max 2min/attempt)
- `build::verify_platform_binaries()` runs `assert_executable` / `assert_executable_runs` on all critical binaries after the build — catching anything postinstall missed

---

## 16. Verification Returned Silently on First Failure

**PR:** #254

**Symptom:** Build verification said "failed" but didn't say WHICH artifact was missing. Debugging required reading the raw log file.

**Root cause:** `verify_build_artifacts()` used short-circuit `|| return 1` on the first missing file — no diagnostic output, no way to know which check failed.

**Current solution:**
- `build::dump_build_report()` and `build::dump_install_report()` in `40-build.sh` check ALL artifacts and report each one's status with checkmarks or X marks. On failure, the full report is printed before `assert_fail` fires.
- `assert_executable_runs` in `03-assert.sh` includes the `file()` output of the binary and the host architecture in the error message.

---

## 17. node-pty spawn-helper Permissions

**From memory, not a specific PR**

**Symptom:** Terminal integration failed with `posix_spawnp failed` when trying to spawn a shell.

**Root cause:** node-pty prebuilds ship the `spawn-helper` binary without the executable (+x) permission bit set.

**Current solution:**
- Fixed in `postinstall.ts` with a `chmod +x` on the spawn-helper binary. This is outside the install-dev.sh scope but is a related postinstall concern.

---

## 18. GitHub Connectivity Not Checked Until Clone

**No specific PR — addressed in the OOP rewrite**

**Symptom:** The installer would churn through dependency installation (possibly prompting for sudo), then fail 10 minutes later when `git clone` couldn't reach GitHub.

**Root cause:** No connectivity check before attempting the clone. Corporate firewalls, VPNs, and SSH key issues were only discovered deep in the install flow.

**Current solution:**
- `install-dev.sh` bootstrap checks GitHub connectivity immediately after ensuring curl/git are available — before any dependency installation begins
- `assert_github_access()` in `03-assert.sh` hits the GitHub API and produces specific error messages for different failure modes (network error, 401/403 auth, 404 not found, unexpected status)

---

## Architecture: Why the Modular Rewrite Prevents These

The original monolithic `install-dev.sh` had OS-specific logic scattered across case statements throughout one file. Fixing a macOS issue could break Linux because the code was interleaved. The rewrite addresses this structurally:

| Problem Pattern | Old Script | New Architecture |
|---|---|---|
| Fixing one OS breaks another | All OS logic in case statements in one file | Each OS in its own file (`10-os-macos.sh`, `11-os-linux.sh`, `12-os-windows.sh`) — impossible to cross-contaminate |
| Silent failures | `\|\| true` on critical commands | `assert_fail` with giant red box; `try_with_fallback` announces failures loudly |
| Missing verification | One function checked everything loosely | Three dedicated verification phases: install artifacts, build artifacts, platform binaries |
| GitHub unreachable discovered late | Failed during `git clone` after 10+ minutes of dep installation | `assert_github_access` at bootstrap — before deps |
| Missing interface method for an OS | Runtime "command not found" crash | `validate_os_module` catches at load time before any work begins |
| Build tools missing mid-build | Cryptic ENOENT from Node subprocesses | `build::verify_prerequisites` asserts all tools before starting |
| Arch mismatch on binaries | Silent pass, crash at runtime | `assert_executable_runs` with `file()` output in error |

### File Layout

```
install-dev.sh                    # Slim bootstrap (~320 lines) — detect OS, install git/curl, clone repo
installer/
  controller.sh               # Linear orchestrator — walks through all phases
  lib/
    00-ui.sh                  # Terminal UI: colors, spinners, run_silent, run_with_status
    01-errors.sh              # Error reporting, try_with_fallback
    02-platform.sh            # OS detection, dispatch(), validate_os_module()
    03-assert.sh              # assert_command, assert_file, assert_executable_runs, assert_github_access
    10-os-macos.sh            # macos:: namespace — all macOS logic
    11-os-linux.sh            # linux:: namespace — all Linux logic
    12-os-windows.sh          # windows:: namespace — all Windows logic
    20-deps.sh                # Dependency audit/plan/execute/verify orchestration
    30-repo.sh                # Version resolution, clone, checkout
    40-build.sh               # yarn install, yarn build, artifact verification
```
