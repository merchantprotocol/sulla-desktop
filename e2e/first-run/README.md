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
