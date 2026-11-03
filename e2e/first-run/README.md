# First-run fresh-install simulator

This harness launches the built Electron app with a new throwaway `HOME` for every test. Because all Sulla Desktop paths, including Electron `userData`, derive from `HOME`, each launch behaves like a new installation without touching the developer's real Sulla data. `SULLA_MOCK_BACKEND=1` avoids starting a VM. Test-only Cloud, OAuth, vault and preflight overrides are accepted only by an unpackaged app with `SULLA_E2E=1`; packaged production builds ignore them.

## Run in CI

Build first, then run one pass:

```bash
yarn build
yarn e2e:first-run --repeat 1
```

Repeat a scenario to find flakiness:

```bash
yarn e2e:first-run --repeat 20 --grep "Cloud down"
```

Each run is recorded in `test-results/first-run/repeat-summary.json`. Playwright retains a trace and screenshot for failures. Do not run this suite in parallel: it deliberately uses one worker so Electron lifecycle failures stay attributable.

From GitHub, open **Actions → First-run Electron E2E → Run workflow**. Choose the repeat count, Ubuntu or macOS, and an optional Playwright grep expression. The workflow uploads `test-results/first-run` even when a test fails.

## Real VM pass on a Mac

This is intentionally not used by CI. After downloading a packaged `.app` or `.dmg`, run:

```bash
scripts/fresh-install-real.sh "/path/to/Sulla Desktop.dmg"
```

The script launches the packaged build with a throwaway `HOME`, prints its exact location, and prints the cleanup command. It never reads or modifies the normal `~/.sulla` or Sulla Desktop application data. Quit the simulated app before running the printed removal command.

## Fake services

`fakes.ts` provides local HTTP endpoints for Cloud, OAuth, and vault writes. Tests may inspect received values in process memory, but assertions and logs must never print credential values. The fake modes cover new user, existing user, 5xx, and timeout; OAuth behavior is selected with the test-only environment; vault readiness is likewise test-controlled.

## Side-by-side real-VM repeat loop (primary fresh-install check)

`scripts/first-run-vm-loop.sh` runs a packaged build as **Sulla (first-run test)** while the normal Sulla Desktop and its agents remain running. It never quits the live app. The test process requires both `SULLA_INSTANCE=firstrun-test` and the private `--sulla-test-instance` launch flag; ordinary packaged launches refuse instance mode.

Every iteration gets its own HOME, Electron userData, settings, `first-run-state.json`, Sulla directories, runtime directory, VM `data.img`, sockets, and a 10,000 host-port offset. The test app does not register the live `sulla://` protocol and has its own single-instance lock because its `userData` is separate. Its menu/dock name and first-run window say **Sulla (first-run test)** and the dock carries a `TEST` badge.

A second VM consumes real resources while live Sulla keeps running. The script checks free+inactive RAM first and refuses to launch unless the configured test VM size plus a 3 GB safety margin is available. Default: 5 GB test VM, therefore at least 8 GB available.

```bash
scripts/first-run-vm-loop.sh --app "/path/to/Sulla Desktop.dmg" --repeat 5
scripts/first-run-vm-loop.sh --app "/Applications/Sulla Desktop.app" --repeat 3 --kill-at sulla-services
```

`--kill-at PHASE` kills **only the isolated test PID** once when that startup phase appears, then relaunches the same isolated HOME and runtime to exercise resume. The CSV summary records start time, elapsed seconds, result, paths, and logs per attempt. Successful run directories are removed; failures can be retained with `--keep-failures`. The summary prints the exact test root and cleanup command. Never substitute the live runtime path.

GitHub-hosted runners still use the mock-backend Playwright layer because they do not provide the macOS nested virtualization required for a real Sulla VM. The real-VM loop is Mac-only and intentionally absent from CI.
