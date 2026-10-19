# Native macOS Files/FUSE acceptance proof

This is one required acceptance run before production rollout can be enabled.
The harness alone does not prove production mount startup or agent wiring. The
run must use a reviewed Desktop proof build and disposable synthetic data only.
It must not inspect, copy, migrate, mount, or modify personal files, credentials,
wallet/vault data, existing Files data, or Sulla/PostgreSQL application data.

## Isolated harness

The harness is `live-proof.mjs`; native mode does not launch Sulla Desktop or
its production bootstrap. `macos-native-proof-bootstrap.mjs` synchronously
redirects Electron user data, session data, caches, logs, and crash dumps into
an owned disposable root before app readiness or any harness import. It then
creates a fresh `mkdtemp` root, a sub-kilobyte
synthetic file, an ephemeral PostgreSQL cluster bound to loopback, the real
`LocalFilesManager`/HTTP API, the production `SullaFilesNativeBroker`, the real
`SullaFilesSourceGateway`, and the real Python FUSE adapter in a disposable
Docker container. The chooser must select the one file the harness created.
Every other selection is rejected. Mac App Store builds must return a
security-scoped bookmark. Non-MAS builds use an application-enforced session
selection and a pinned broker handle, matching Desktop; this does not prove
OS sandbox enforcement or durable permission. Restart requires reselection. It never reads a configured database URL, Sulla
home, Desktop user-data directory, Files root, Vault, or wallet path.

Production rollout remains disabled during this proof. Native proof mode is a
separate process and does not enable the production runtime.

### Host prerequisites

- macOS host and a reviewed checkout of this exact PR head.
- Native macOS dependencies already present at
  `/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop/node_modules`; do not
  install dependencies or change the proof worktree's Linux `node_modules`
  symlink as part of the acceptance run.
- Docker Desktop running with Linux FUSE available to a privileged container.
- PostgreSQL binaries `initdb`, `pg_ctl`, and `psql` on `PATH`.
- Ports `48793` and `50000 + (proof PID % 10000)` free on loopback. Override the
  HTTP port with `SULLA_FILES_PROOF_PORT` if needed.
- At least 1 GiB free disk and 1 GiB free RAM. The FUSE container is capped at
  1 CPU, 512 MiB RAM, and 128 processes; the source gateway additionally caps
  each file at 64 MiB and four concurrent requests. The normal fixture is less
  than 1 KiB. No GPU is used.

Build only the disposable FUSE runner image:

```sh
cd /absolute/path/to/reviewed/sulla-desktop-worktree
docker build \
  --file services/sulla-files/experimental/fuse/Dockerfile.macos-proof \
  --tag sulla-files-fuse-proof:local \
  services/sulla-files/experimental/fuse
```

Run the staging wrapper from the reviewed worktree, not the Desktop
application. The wrapper archives exactly `HEAD` into an owned temporary
directory, links the existing native dependencies only inside that staged
copy, supplies Electron isolation switches at process launch, and loads the
dedicated bootstrap. Its exit trap removes the staged source and Electron
profile even when the Trace 7 child deliberately kills itself:

```sh
cd /absolute/path/to/reviewed/sulla-desktop-worktree
SULLA_FILES_PROOF_FUSE_IMAGE=sulla-files-fuse-proof:local \
sh services/sulla-files/experimental/fuse/run-macos-native-proof.sh
```

The chooser opens at the generated `round-trip.txt`. Select that exact file.
The process prints one JSON object containing the loopback control URL, a
redacted handle prefix, a random fixture label, and the isolation mode. It does
not print the temporary host path, capability, token, file contents, database
credentials, or bookmark.

## Required traces

Record identifiers, revisions, SHA-256 hashes, and status codes only. The
control page returns hashes and Files ids/versions, never source bytes,
credentials, bookmarks, capabilities, database credentials, or host paths.

1. **Reachability:** refresh Files and the FUSE mount. The selected file must be
   visible from the durable native-source index despite the runtime having no
   configured watched root.
2. **Ordinary write:** open the existing mounted file in place, change its
   synthetic bytes, call `fsync`, and close it. `fsync` must wait until the
   native source hash/revision and Files current version match the durable
   publication result. Read both surfaces and compare hashes.
3. **External refresh:** edit the selected source directly, wait for the bounded
   Electron poll, and refresh the mount. Files must advance from the recorded
   base version with CAS and expose the new hash.
4. **Concurrent conflict:** hold a stale in-place FUSE edit, change the native
   source directly, then flush the FUSE handle. Flush must return `EIO`; the
   external bytes must remain in the original Files entry and the stale FUSE
   bytes must exist in a visible `conflicted copy Files` entry. Verify both
   hashes and their Files version ids.
5. **Lock and drain:** begin a publication, lock Files, and confirm lock rejects
   new broker requests and does not complete until in-flight source and Files
   operations have drained or reached durable recovery. The old opaque handle
   must fail after lock. Use **Lock + drain** after traces 1–4. This control
   pauses an in-flight external refresh at the production broker's injected
   Files boundary, starts the production lock order, proves the drain waits,
   releases the operation to its durable Files commit, and then verifies the
   old handle is revoked.
6. **Session recovery:** unlock/relaunch without reusing the old handle. Files
   must show **Reselect source**. Reselect the same disposable file, confirm a
   new handle is indexed, and confirm the revoked handle remains unusable. Use
   **Reselect + recover** immediately after trace 5; the chooser must be used a
   second time for the same generated file.
7. **Interrupted publication:** run the two-launch sequence below. The first
   proof process publishes the new synthetic bytes through the production
   `SullaFilesNativeBroker`, persists only its generated isolated fixture state,
   and kills itself immediately before the Files acknowledgement request. The
   second process accepts only the generated fixture key, validates the exact
   owner/mode/marker of the harness-created state, asks for the same synthetic
   file through the chooser again, and requires a new opaque handle. The shared
   production broker may acknowledge recovery only after the original source
   revision/hash and exact Files base/result versions all match the durable
   action and the reselected source revision/hash.

   First launch:

   ```sh
   cd /absolute/path/to/reviewed/sulla-desktop-worktree
   SULLA_FILES_PROOF_TRACE7=prepare \
   SULLA_FILES_PROOF_FUSE_IMAGE=sulla-files-fuse-proof:local \
   sh services/sulla-files/experimental/fuse/run-macos-native-proof.sh
   ```

   Select the generated file, then use **Trace 7 interrupt**. The process must
   end from `SIGKILL` after printing `published-not-acknowledged`; record the
   printed `fixtureKey`, revisions, hashes, operation id, and Files version ids.
   A normal exit or a Files acknowledgement is a failed trace.

   Second launch from the same reviewed checkout and commit:

   ```sh
   cd /absolute/path/to/reviewed/sulla-desktop-worktree
   SULLA_FILES_PROOF_TRACE7=recover \
   SULLA_FILES_PROOF_TRACE7_KEY=<fixture-key-from-first-launch> \
   SULLA_FILES_PROOF_FUSE_IMAGE=sulla-files-fuse-proof:local \
   sh services/sulla-files/experimental/fuse/run-macos-native-proof.sh
   ```

   Reselect the same generated file. Recovery fails closed for a reused handle,
   a different file, any changed owner/mode/marker, a symlinked fixture, a
   source revision/hash mismatch, or a different Files base/result version. A
   successful second process prints `recovered-and-cleaning`, stops the exact
   owned proof container and PostgreSQL cluster, closes the gateway, and removes
   the exact marked fixture root before exiting. Verify the container/process
   checks in Cleanup below after the second launch.

## Exit criteria

Production rollout may be considered only when every trace above
is captured from the same implementation used by Desktop, no direct host mount
or FUSE-to-host path exists, and all temporary synthetic data is removed. Any
unexpected acknowledgement, missing visible conflict, reused revoked handle,
or source/Files hash mismatch fails the proof.

The harness makes trace 7 runnable, but this change does not claim native macOS
evidence. The proof still has to be run from the reviewed commit on macOS with
the chooser and Docker FUSE. Linux/VM exercise is implementation evidence only.
Production rollout remains disabled pending combined runtime acceptance.

## Cleanup and evidence isolation

Use **Stop + clean** on the control page (or press `Ctrl-C` once when running
the proof directly). The cleanup handler unmounts/stops the named proof
container, stops the ephemeral PostgreSQL process, closes the gateway (which
releases the security scope and revokes handles), and removes the entire
temporary root. Then verify cleanup without inspecting any data:

```sh
docker ps --all --filter 'name=sulla-files-native-proof-' --format '{{.Names}}'
pgrep -fl 'sulla-files-live-proof-' || true
```

Both commands must return no proof process/container. Remove the reusable image
after review if it is no longer needed:

```sh
docker image rm sulla-files-fuse-proof:local
```

Evidence may contain only the PR SHA, harness image digest, fixture label,
redacted handle prefix, operation/file/version ids, status/EIO results, and
SHA-256 hashes. Do not capture the chooser, control-page tokens, process
environment, Docker inspection output, temporary paths, file contents, or
PostgreSQL logs. Production rollout remains disabled after a successful run;
enabling it requires combined production lifecycle and agent acceptance.

Trace 7 retains one owner-only `0700` synthetic fixture root between the two
processes. Its owner-only `0600` marker contains only generated synthetic keys,
loopback port metadata, proof resource identity, and the revision/hash/version
evidence required for restart. It never accepts a caller-supplied directory,
never follows a fixture/source symlink, never reads Desktop configuration or
environment database credentials, and never opens Sulla application, wallet,
or vault data. The retained PostgreSQL cluster, encrypted chunks, source, and
marker stay within the same 1 GiB disk/RAM acceptance budget above and are
removed by the successful recovery process.
The staging wrapper's separate Electron profile is removed after each launch,
including the intentional first-launch `SIGKILL`; it is never retained with
the Trace 7 fixture.
