# Sulla routing, Decide ownership, and startup resilience

```flowstate-json
{
  "schema_version": 3,
  "plan_id": "sulla-routing-decide-startup-20261121",
  "scope_version": "1",
  "mode": "bind-current",
  "authority": [
    {
      "path": "project-specsheet.md",
      "sha256": "5d3eab6645ff245b912b2b073b5082e6288779aca12a76cbcf23690889440af3"
    }
  ],
  "mockup_gate": {
    "status": "approval-waived",
    "evidence": "The user explicitly authorized all listed fixes and asked to proceed with the established Sulla interface."
  },
  "human_gates": ["pr", "merge", "release", "deploy", "production"],
  "review_chain": {
    "builder": {"model": "gpt-6.2-sol-medium", "family": "openai"},
    "review_fixer": {"model": "claude-opus-5-5", "family": "anthropic"},
    "verifier": {"model": "grok-4.7", "family": "xai"}
  },
  "chunks": [
    {
      "id": "C1",
      "outcome": "Fable follows saved agent routing, each decision appears in one owning Decide tab, and stale chat activity clears without changing existing handoff behavior.",
      "requirements": ["REQ-1", "REQ-2", "REQ-3"],
      "depends_on": [],
      "allowed_paths": [
        "pkg/sulla-desktop/agent",
        "pkg/sulla-desktop/pages/chat",
        "pkg/sulla-desktop/shared",
        "pkg/sulla-desktop/vault-broker",
        "pkg/sulla-desktop/main/MCPServerHost.ts",
        "project-specsheet.md"
      ],
      "non_goals": ["Hard-code Advisor to Fable", "Change captured routes for running or parked jobs", "Answer or dismiss real user decisions"],
      "chunk_fit": {
        "ownership_cone": "model alias routing, durable decision ownership, chat liveness, visible Decide labeling, tests, and acceptance",
        "starts_after_boundary": null
      },
      "visual_acceptance": {
        "applicability": "required",
        "reason": "The chat side dock visibly renames For You to Decide and changes which thread presents an actionable card.",
        "surfaces": [
          {
            "id": "decide-single-owner",
            "requirements": ["REQ-2", "REQ-3"],
            "reference": {
              "path": "project-specsheet.md",
              "sha256": "5d3eab6645ff245b912b2b073b5082e6288779aca12a76cbcf23690889440af3",
              "locator": "Fable aliases and Decide ownership",
              "approval_evidence": "User directed the duplicate For You fix and rename to Decide, then authorized all remaining work."
            },
            "exceptions": [],
            "input_paths": ["pkg/sulla-desktop/pages/chat", "pkg/sulla-desktop/shared/decisions.ts"],
            "input_sha256": null,
            "candidate_id": null,
            "status": "accepted",
            "cases": [
              {"id": "single-owner", "kind": "interaction", "expectation": "A spun-off chat and its parent show one actionable decision total, owned by the correct Decide tab, without refresh.", "context": "existing desktop profile, parent and child chats, unanswered disposable QA request", "viewport": {"width": 1440, "height": 900, "scale": 1}},
              {"id": "settled-layout", "kind": "visual", "expectation": "Decide, empty, active and settled states retain the established compact side-dock hierarchy without overflow.", "context": "existing desktop profile, dark theme", "viewport": {"width": 1440, "height": 900, "scale": 1}}
            ],
            "receipt": "Native Electron QA on 2026-11-21 showed the dark side dock with Decide, AI Team, Files, preserved chats, and no manual refresh. Canonical-owner and settled/empty states are covered by the focused Decide and SideDock suites; no real unanswered user decision was modified."
          }
        ]
      },
      "risk": "high-risk",
      "status": "complete",
      "acceptance_commands": ["yarn test:agent --runInBand"],
      "receipt": "Focused routing, Decide, side-dock, activity, composer and provider-pin tests passed. Live disposable Advisor QA first observed the saved Astra fallback while Claude was backed off, then direct Fable succeeded and the same Advisor profile returned on Fable after provider health recovered. No Advisor-specific routing rule was introduced.",
      "blocker": null
    },
    {
      "id": "C2",
      "outcome": "Sulla cold-launches and spawns children on local temporary storage even when the inherited macOS temp path is removable, missing, or unwritable.",
      "requirements": ["REQ-4"],
      "depends_on": ["C1"],
      "allowed_paths": ["background.ts", "pkg/sulla-desktop/main/startup", "pkg/sulla-desktop/agent/tests/Unit/Main", "project-specsheet.md"],
      "non_goals": ["Mount or scan removable drives", "Change non-macOS temp handling", "Delete user files"],
      "chunk_fit": {
        "ownership_cone": "early main-process temp normalization, deterministic tests, native cold-launch and child-process verification",
        "starts_after_boundary": {"type": "stable-interface", "evidence": "C1 freezes the chat and routing behavior before startup acceptance restarts the app."}
      },
      "visual_acceptance": {
        "applicability": "n-a",
        "reason": "This changes inherited process environment and startup reliability without changing a visible surface.",
        "surfaces": []
      },
      "risk": "high-risk",
      "status": "complete",
      "acceptance_commands": ["yarn test:agent pkg/sulla-desktop/agent/tests/Unit/Main/TempDirectoryGuard.spec.ts", "node scripts/check-license-headers.mjs"],
      "receipt": "TempDirectoryGuard tests passed. Native Electron was launched with TMPDIR, TMP and TEMP pointing at /Volumes/Acer/rc-tmp; child audio/runtime sockets were created under /private/tmp and the UI launched normally.",
      "blocker": null
    },
    {
      "id": "C3",
      "outcome": "Interrupted and parked workers recover once with the same durable workspace, saved model and agent identity, while parked jobs remain parked until their normal wake condition.",
      "requirements": ["REQ-5"],
      "depends_on": ["C2"],
      "allowed_paths": ["pkg/sulla-desktop/agent/services", "pkg/sulla-desktop/agent/app", "pkg/sulla-desktop/agent/tests", "assets/runtime/guest", "services/sulla-agent", "project-specsheet.md"],
      "non_goals": ["Delete existing workspaces", "Resume terminal jobs", "Change a running job to newly edited model settings"],
      "chunk_fit": {
        "ownership_cone": "durable workspace binding, restart resume packets, original persona identity, idempotent recovery and acceptance",
        "starts_after_boundary": {"type": "stable-interface", "evidence": "C2 establishes the unified app build used for force-quit recovery acceptance."}
      },
      "visual_acceptance": {"applicability": "n-a", "reason": "The visible hierarchy is unchanged; acceptance verifies persisted runtime state and recovered worker execution.", "surfaces": []},
      "risk": "high-risk",
      "status": "complete",
      "acceptance_commands": ["yarn test:agent --runInBand", "yarn build", "node scripts/check-license-headers.mjs"],
      "receipt": "Two forced Electron restarts recovered the same real worker job. The workspace marker retained its exact 35-byte content and SHA-256 dd7459cee54f68736661b0643e0242afa5b77e535dc3eb11037ecd0518d00bee, the worker retained gpt-6-luna at Max, restart count advanced once per restart, and the recovered container retained agent-id quick-fixer after the identity repair. The existing coding-manager remained parked during the controlled proof. The task-owned marker was removed afterward.",
      "blocker": null
    }
  ],
  "final_review": {
    "candidate_id": "e3fdd3deb",
    "fix_cycles": 1,
    "records": [
      {
        "reviewer": "Claude Opus 5.5 high",
        "review_id": "do-mwqs22yk-7t9zn3",
        "target": "869d6fd05..ae113b078",
        "finding": "Long in-process tools were not registered with the shared liveness tracker and completed chat activity keys could be resurrected.",
        "resolution": "ToolExecutor now registers sequential and parallel in-process calls, completed turn keys are removed and cannot be resurrected, and focused regression tests pass."
      },
      {
        "reviewer": "Grok 4.7 Build",
        "review_id": "01a1ff7f-6bc1-7531-b663-52e03704bc2b",
        "target": "869d6fd05..ae113b078",
        "finding": "A failed automatic resume dispatch could be requeued after the startup recovery loop had already exited.",
        "resolution": "Recovery now waits only until dispatch acceptance, immediately requeues an early failure without waiting for the worker to finish, and the startup failure-path regression test passes."
      }
    ]
  }
}
```

## Current decision

none

## Notes

The builder is the user-selected GPT-6.2-Sol at Medium effort. Native restart acceptance preserved existing chats, running and parked jobs, workspace bytes, and the rollback point. The unified build restored the dark first frame and settings styling that were absent from the temporary worker-only build. Pull-request publication is authorized; merge, release, deployment, and production changes are not.
