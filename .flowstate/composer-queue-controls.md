# Composer queue controls

```flowstate-json
{
  "schema_version": 3,
  "plan_id": "composer-queue-controls-20261121",
  "scope_version": "1",
  "mode": "create-new",
  "authority": [{"path": "/Users/seth/Documents/SCR-20261121-iwpy.png", "sha256": "535e5324f864cd2768c19024618ef0672732c21b85afc39984a88e1534fc0c5e"}],
  "mockup_gate": {"status": "approval-waived", "evidence": "The user approved the proposed split Queue and Stop interaction on 2026-11-21."},
  "human_gates": ["pr", "merge", "release", "deploy", "production"],
  "review_chain": {
    "builder": {"model": "gpt-6.2-sol", "family": "openai"},
    "review_fixer": {"model": "claude-opus-5-5", "family": "anthropic"},
    "verifier": {"model": "grok-4.7", "family": "xai"}
  },
  "chunks": [{
    "id": "C1",
    "outcome": "While Sulla is working, typing and Enter clearly queue a message and Stop remains a separate secondary action.",
    "requirements": ["REQ-1", "REQ-2", "REQ-3"],
    "depends_on": [],
    "allowed_paths": ["pkg/sulla-desktop/pages/chat/components/composer", "pkg/sulla-desktop/agent/tests/Unit/Chat", ".flowstate/composer-queue-controls.md"],
    "non_goals": ["Changing queue ordering or delivery semantics", "Interrupting or restarting running agents during source verification", "Changing transcript-level stalled-run actions"],
    "chunk_fit": {"ownership_cone": "Composer send, queue and stop controls, their focused regression tests, and desktop interaction acceptance.", "starts_after_boundary": null},
    "visual_acceptance": {
      "applicability": "required",
      "reason": "The repair changes the visible desktop composer and its running-state interaction.",
      "surfaces": [{
        "id": "running-composer",
        "requirements": ["REQ-1", "REQ-2", "REQ-3"],
        "reference": {"path": "/Users/seth/Documents/SCR-20261121-iwpy.png", "sha256": "535e5324f864cd2768c19024618ef0672732c21b85afc39984a88e1534fc0c5e", "locator": "Running Product Owner thread composer", "approval_evidence": "User approved separate Queue and Stop controls on 2026-11-21."},
        "exceptions": [{"criteria": "Do not reproduce the screenshot's single Stop control as the composer primary action.", "reason": "The screenshot records the confusing state being repaired rather than an approved target layout.", "authorization": "The user approved the separate Queue and Stop recommendation on 2026-11-21."}],
        "input_paths": ["pkg/sulla-desktop/pages/chat/components/composer/Composer.vue", "pkg/sulla-desktop/pages/chat/components/composer/ComposerSend.vue", "pkg/sulla-desktop/pages/chat/components/composer/ComposerSendBehavior.ts", "pkg/sulla-desktop/pages/chat/components/composer/RunControls.vue", "pkg/sulla-desktop/pages/chat/components/composer/QueueStrip.vue"],
        "input_sha256": null,
        "candidate_id": "c4533a652-composer-queue-controls-v1",
        "status": "passed",
        "cases": [
          {"id": "running-empty", "kind": "visual", "expectation": "The running composer shows a distinct Stop action and a disabled Queue action without implying that Stop is required to type.", "context": "desktop, Product Owner thread, Sulla working, empty draft", "viewport": {"width": 1440, "height": 900, "scale": 1}},
          {"id": "running-draft", "kind": "interaction", "expectation": "Typing enables Queue, Enter queues once, the draft clears, and the run is not stopped.", "context": "desktop, Product Owner thread, Sulla working, non-empty draft", "viewport": {"width": 1440, "height": 900, "scale": 1}},
          {"id": "idle-send", "kind": "interaction", "expectation": "When idle, the same primary control sends normally and the Stop action is absent.", "context": "desktop, Product Owner thread, Sulla idle, non-empty draft", "viewport": {"width": 1440, "height": 900, "scale": 1}}
        ],
        "receipt": {
          "runtime": "Sulla Desktop v1.8.0-rc.1-654-gc4533a652",
          "observed_at": "2026-11-21T11:07:00-06:00",
          "results": [
            "Running with an empty draft showed separate Stop and disabled Queue controls.",
            "Entering a follow-up and pressing Enter queued exactly one message without stopping the active response.",
            "The queued message ran after the original response, then the composer returned to idle Send.",
            "The separate Stop control ended a disposable active response and returned the composer to idle Send.",
            "The pre-existing IDS build lead and its single worker recovered without a duplicate job."
          ]
        }
      }]
    },
    "risk": "routine",
    "status": "complete",
    "acceptance_commands": [
      "TMPDIR=/private/tmp ./node_modules/.bin/vitest run --config vitest.agent.config.mts pkg/sulla-desktop/agent/tests/Unit/Chat/ComposerQueueControls.spec.ts",
      "TMPDIR=/private/tmp ./node_modules/.bin/eslint pkg/sulla-desktop/pages/chat/components/composer/ComposerSend.vue pkg/sulla-desktop/pages/chat/components/composer/ComposerSendBehavior.ts pkg/sulla-desktop/pages/chat/components/composer/RunControls.vue pkg/sulla-desktop/agent/tests/Unit/Chat/ComposerQueueControls.spec.ts",
      "node scripts/check-license-headers.mjs"
    ],
    "receipt": {
      "tests": "ComposerQueueControls.spec.ts: 7 passed",
      "lint": "ComposerSend.vue, ComposerSendBehavior.ts, RunControls.vue and ComposerQueueControls.spec.ts passed focused ESLint",
      "build": "Production renderer and Electron build passed with renderer hash 226421ffc3248ff4",
      "license": "Changed source and test files carry GPL-2.0-or-later headers; full repository scan remains blocked by 67 pre-existing unrelated files.",
      "runtime": "Queue, Enter-to-queue, separate Stop, idle Send, and one-time IDS worker recovery verified in the native app."
    },
    "blocker": null
  }],
  "final_review": {
    "candidate_id": "c4533a652-composer-queue-controls-v1",
    "fix_cycles": 1,
    "records": [
      {"family": "anthropic", "model": "claude-opus-5-5", "verdict": "INCOMPLETE", "result": "Identified the live-child popover persistence and hover-scope issues; both were fixed and covered by regression tests."},
      {"family": "xai", "model": "grok-4.7", "session_id": "01a1fefd-06f8-7dd3-b945-be530d597397", "verdict": "PASS", "findings": []}
    ]
  }
}
```

## Current decision

none

## Notes

The primary composer action remains Send when idle and becomes Queue while a run is active. Stop is always a separate secondary control. Queue delivery behavior remains unchanged.
