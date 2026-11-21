# Sulla Desktop agent model tiers and safe handoffs

**Engineering plan, revised November 20, 2026.** Intended audience: Sulla maintainers, QA and owners configuring Product Owner chats. Phase 1 covers routing and recovery. Later phases have separate acceptance gates. The source baseline for this plan is `03773f26cc2862ea060a2d04af4875e983d21d3a`. The upstream main checked during review was `7bd17e4fb6759efc6d73fee83a35f662e76b0796`. Use a branch containing the Product Owner Workflow integration, or land that prerequisite before porting the integration checks upstream.

## Outcome for an owner

An agent keeps its job, prompt, tools and permissions when the owner changes its model. The owner can use shared settings or select an ordered set of models and reasoning efforts for a particular agent. A Product Owner chat can have its own handoff choices. Each delegated job carries enough evidence to explain which configuration applied and which model, if any, the provider identified.

For example, a tester inheriting the Frontier list follows edits to that list on new launches. Opening its profile or saving a description preserves inheritance. When the owner explicitly saves a model selection, subsequent jobs use that agent's selection. Returning to shared defaults restores live inheritance. A worker already parked at a checkpoint keeps its saved route and position when it wakes. Configuration changes do not themselves launch, wake or cancel workers.

## Findings behind the change

The discovery report linked unexpected tester runs to the shared Frontier list and found that the tester's delegation prompt explicitly recommended an Opus-named worker. A role name is a poor guide to execution. The code also has separate paths for a chat selection, an agent binding, an explicit task request and global class routing. A saved binding could take precedence over a requested model without explaining the conflict.

Grok and Fable independently reviewed the full original plan and the same source snapshot. Both asked for revisions before implementation. A per-agent binding includes approved subscription accounts. Copying a class list into a binding at upgrade can reject the list, change billing or freeze settings that should stay live. The legacy router moves temporarily limited providers behind healthy providers across the whole list. One candidate per tier cannot preserve that behavior if a limited Tier 1 always wins. Recovery looks up a persisted agent slug and reads a version-1 flat candidate array with a selected index. A rename or route format change can fail an existing job.

Fable's reviewer receipt identified `claude-fable-5-2` on a Claude Max subscription. Grok's identified `grok-4.7-build`. Those receipts establish the reviewer identities for this plan. The model used by the historical Sulla job remains unknown. Validate each installed provider's live catalog before recommending an exact version.

## Decisions and ownership

| Setting | Authority | Effective time |
| --- | --- | --- |
| Human chat model selection | Existing chat picker | The chat's applicable new human turns |
| Chat-specific delegated step | Existing AI Team settings for that chat and step, subject to allowed delegates and independent-review checks | New handoffs in that chat |
| Explicit agent configuration | Existing installation-owned per-agent binding keyed by slug and exact definition ID | New jobs and eligible new unpinned turns |
| Inherited agent | Existing shared class or Agents list, including its rules and health policy | Resolved live through the current router |
| Parked or running job | Route saved with that job and its current candidate position | Same generation through wake or recovery |

Use the existing guarded settings writer, revision and edit token. Store tier configuration alongside the flat compatibility fields. Existing flat bindings retain legacy launch behavior until explicitly edited. No boot migration creates bindings for inherited agents. Reading a profile or starting up with the vault unavailable must not write settings. Returning to inheritance removes only the exact owned binding.

## Phase 1 implementation contract

1. **Validate an explicit configuration.** Accept version 1, up to ten tiers of up to ten candidates each, with a provider, model and optional advertised effort. Reject malformed tiers and duplicate provider/model/effort tuples. The existing compact editor can express an ordered sequence of single-model tiers. Group editing and YAML belong in Phase 2. Preserve a previously saved grouping when a flat editor cannot safely represent its edit.
2. **Keep the existing subscription boundary.** Check the verified live catalog on save. Bind each supported provider to its approved account. On use, recheck that account and Never-use policy. A locked or temporarily unreadable vault can enter the existing bounded wait. An account change or a permanent refusal requires attention. An API key, a different subscription or a similarly named provider is never implicit permission to spend. Additional provider adapters require separate implementation and acceptance.
3. **Order at launch.** Start with healthy candidates in tier and entry order. Put providers currently in backoff after healthy candidates across all tiers, preserving tier and entry order within each group. Use the router's existing health signal. A quota estimate alone is insufficient to declare a provider unavailable. With cross-company fallback off, use the first entry's known company as the boundary and exclude unknown companies. Even when enabled, only explicitly approved subscription accounts are eligible.
4. **Check launch requests at handoff.** For explicitly edited tiers, default to listed models only. An explicit exact request pins that job to that candidate. If unavailable, report it instead of silently spending another subscription. The optional never policy rejects model requests. The optional any policy still requires the requested provider to have an approved account in this binding and the exact model and effort to pass current policy. An explicit request conflicting with the chat step's effective selection fails before launch. Save the request separately from the selected candidate. Keep the pre-upgrade behavior for untouched legacy mappings and unbound agents.
5. **Freeze job state.** Keep the version-1 job route readable by old recovery code. Persist the ordered flat candidates, current index, approved accounts and exact definition identity. Tier numbers and request evidence can be additive. Save fallback progression before invocation. Recovery must reuse the stored selection and never look up a new owner mapping for an existing job. A shared-settings launch needs enough execution evidence to resume its chosen model after an owner edit. Preserve the original authentication path.
6. **Explain provenance.** Distinguish a launch request, the selection used by Sulla and a model reported by a provider in its response. When no provider evidence is present, label the responding model unconfirmed. A role, task label, configured CLI argument or model-authored sentence is insufficient. Effort is the configured effort unless the provider confirms it. Preserve earlier history without retrospectively manufacturing evidence.
7. **Avoid second launch paths.** Integrate with the existing spawn preflight, account guards, job store, wake scheduler and definition editor. Keep runtime permissions, parent/child relationships, prompts, memory and hosted billing policy in their existing owners.

## Phase 1 acceptance

1. Start an inherited tester, edit its shared class preference, and launch another tester. The second choice follows the edit. The agent still has no private binding.
2. Save a description, open and close the editor, and reload settings. Inheritance survives each action.
3. Save an exact agent model with a fallback. Only the edited agent switches to an explicit configuration. Remove it and verify the next job inherits again.
4. Repeat an old flat-list launch with the preferred provider in backoff. The candidate order matches the old build. New tiers try healthy entries before backed-off entries.
5. Disable or block a model or effort. The router skips it and reports the reason if all candidates are exhausted. A missing catalog can recover within the existing wait budget. Stop cancels the wait.
6. Verify that an unlisted model, unsupported effort, unknown company under a company restriction, unapproved account, and attempted API-key substitution cannot start a paid request.
7. Exercise explicit listed, never and any policies. An allowed exact choice in Tier 2 runs first and stays exact. An unavailable requested model does not silently fail over.
8. Exercise AI Team precedence, a conflicting task request, the human chat pin, a visible worker and a hidden worker. Independent review must keep its source-job and different-company checks.
9. Exercise stale saves and a slug reused by a different agent. Preserve the newer mapping, pending publication state and sibling agents.
10. **Parked-worker gate.** Launch model A, persist a unique progress marker, park, change the owner's model to B and restart the task-owned runtime. Allow two wake attempts to compete for the same due wait. Verify one delivery, the same job and thread, the marker, original candidate/index and model A. A separate new job must use B. Repeat or cover the legacy version-1 representation and a job already on a fallback. A check using disposable model responses demonstrates routing and delivery. A real provider receipt is a separate level of evidence.
11. Check response provenance with actual provider metadata, an absent model ID, and an alias that differs from the reported ID. Retain the original request in each case. A lack of output must not produce a reported model.
12. Roll back the application reader in a fixture with saved version-1 jobs. It must still understand the flat route and its selected index. Report separately any unsupported downgrade of newly introduced configuration policies.

## Subsequent phases

### Phase 2. Editor, agent files and preview

Use the existing Agents → Profile → Model controls. Show an inherited class or list with its current effective selection. Allow the owner to create, remove and reorder tier groups, edit advertised efforts, and return to inheritance. Render a next-launch preview from the same routing logic as execution. Surface account readiness and temporary catalog failures. Avoid a second configuration page. Shared class lists still affect inherited agents and must be labelled accordingly.

Extend the v3 agent package with `spec.models.tiers`. Continue to read a legacy pin. Reject contradictory representations with a field-specific error. Preserve the binding's identity and record the last file version and resulting binding revision. A new approved file publication may update unedited file-owned settings. An owner edit wins, and a conflicting file version stays visible for reconciliation. Verify import, publish, subsequent owner edit, republish, two open editors, cancel, and reload. Include 10 × 10 bounds and a narrow editor window.

#### Trying the controls in Product Owner

1. In a Product Owner chat, open **AI Team** and select a step. Read the next agent, model, effort and ordered fallbacks. **At handoff** means the build lead still needs to assign a worker, or the completed implementation determines which independent reviewer qualifies. **Activity** shows what actually returned output.
2. Choose **Change for this chat** to try a different assignment or model order for future work in that chat. Use **Use agent defaults** to return that step to shared routing. Scoping and final handoff share the chat lead.
3. For an agent-wide change, open **Use Cases → Agents → Profile**. Model tiers stay inherited until you explicitly edit and save them. Reorder models within a tier or move whole tiers. Compare the draft preview, cancel to discard it, or save to affect new launches.
4. If a launch has already started or parked, inspect its recorded selection in Activity. To compare new settings with that earlier run, start fresh work. Use the pre-trial restore point described below for a full rollback.

### Phase 3. Job names and safe aliases

Quick Fixer, Builder, Generalist, Lookup, Advisor and Designer have stored names and slugs. The migration retains each definition ID. It protects custom names and a user's ownership of a colliding slug, copies built-in deletion markers, and updates owned model bindings and workflow choices. Previous slugs are accepted when resolving older chat and job references. Code Reviewer and Deep Reasoner remain prospective roles.

The Postgres migration fixture checks a parked job, a deleted built-in, a user-owned Builder and a customized prompt across two applications. Existing job records and their model selections keep the identifiers captured at launch. An app-only downgrade is insufficient after migration. Restore the pre-upgrade app and data together.

### Phase 4. Remove model identity from job instructions

Replace the tester's prescribed model and the coding manager's model-named delegation table with task capability guidance. Replace obsolete planner references and label the designer by role. Examine managed prompts and bundled examples. Keep owner-authored prompts and learned memory outside automatic rewrites. Validate known catalog entries through the configured access method, preserving legitimate older versions and owner choices. Test whole model identifiers rather than matching fragments in common words. When independent review is required, bind the review to a completed implementation in the same chat and compare companies that contributed to it. Unverified authorship requires a choice.

### Optional later work

Offer an explicit save-as-default action for future Product Owner chats. Existing per-chat overrides remain scoped to their chat. A separate usage-ledger project can improve accounting by model and profile. Neither is a prerequisite for compatible tier storage and restart recovery.

## Rollout, rollback and verification boundaries

Start on the branch containing the user's chat routing. Keep unrelated changes and archived prototypes outside the patch. Ship the compatibility reader first. Make new tier behavior opt-in through a deliberate model save. Preserve old settings, chat histories, route positions, workspace identities and job generations. Validate with disposable resources before considering live application installation.

Keep the forced restart, process-level recovery, provider-level identification and full graphical desktop checks as separately reported results. Record concrete model IDs, durable job IDs or fixture identifiers, delivery count and the progress marker when available. Do not infer production readiness from a unit test or a configured model string. Rollback of future launches must preserve newer owner edits, and jobs still in flight require a reader compatible with their captured state.

## Trial in the everyday installation

1. Identify the running executable, working directory, compiled assets and VM data file. The normal Applications shortcut can point to a different build. Apply Phase 1 to the observed everyday source baseline, preserving its additional UI changes.
2. Run the router, account, editor and durable wake tests before switching. Record chat, model-settings, job, vault and workspace identities privately. Check for active workers, imminent wakes, running workflows, queued input and unsaved edits before quitting normally.
3. With the app and VM fully stopped, take a private copy-on-write copy of the VM disk and the host-side Sulla configuration. Preserve the prior build and a launcher that targets it. Verify the cloned disk and host files before starting the candidate. A database dump alone cannot restore workspaces.
4. For a trial, choose a disposable agent and chat. Note its inherited model, edit the shared setting, then explicitly save a different model for that agent. Compare a newly launched job with the earlier job. Dismiss any real-world side-effect prompts during the trial. Returning the agent to shared defaults resets that preference only.
5. Returning to the old executable preserves work produced during the trial but does not undo settings edits. For a full point-in-time rollback, first stop both app and VM, preserve the trial state separately, restore the private checkpoint to its original paths and reopen the recorded prior build. Verify chats, saved routing, vault, workspaces and job counts against the pre-trial record. Full rollback puts local Sulla data back to the checkpoint date. Changes on GitHub or other external systems have their own histories.
6. Keep the restore point until the owner finishes the trial. Store its contents only on the owner's Mac. Share this Markdown plan without the restore point, which contains private app data.

## Code map for maintainers

Paths below the Desktop package are relative to `pkg/sulla-desktop/`. The checkout may have moved since the original investigation.

| Area | File |
|---|---|
| Launch | `agent/tools/agents/spawn_agent.ts`, `agent/tools/agents/manifests.ts` (spawn schema incl. `workflowStep`) |
| Worker routes | `agent/services/WorkerModelRouting.ts`, `agent/languagemodels/workerModelBindings.ts` |
| Router | `agent/languagemodels/modelRouter.ts`, `modelRoutingTypes.ts`, `modelCatalogRules.ts`, `threadModelChoice.ts`, `modelDefaults.ts`, `AgentModelCategoryPolicy.ts`, `index.ts` (`getAgentOverrideService`) |
| Providers | `agent/languagemodels/ClaudeCodeService.ts`, `CodexService.ts` |
| Definitions | `agent/database/models/AgentDefinitionModel.ts`, `agent/builtinAgents/{index.ts,seedBuiltinAgents.ts,builtin-agents.json}` |
| Settings | `agent/database/models/SullaSettingsModel.ts` (`assertWorkerBindingsUnchanged`), `main/modelRoutingIpc.ts` |
| Product Owner Workflow | `shared/productOwnerWorkflow.ts`, `agent/services/ProductOwnerWorkflow.ts`, `pages/chat/components/sidedock/WorkflowPanel.vue` |
| Editor UI | `components/studio/StudioAgentsPage.vue`, `components/studio/AgentModelControls.vue`, `components/settings/sections/ModelsSection.vue`, `components/studio/AgentDirectoryTab.vue` |
| Agent files | `main/marketplace/agentPackageManifest.ts`, `main/sullaUseCaseFiles.ts` |
| Directory | `agent/services/AgentDirectoryService.ts` |
| Prompts | `agent/prompts/sections/soul.ts`, `resources/memory-seed/subjects/sulla-agents.md` |
| Workflow manager (unrelated bug found on the way) | `services/sulla-workflows/src/manager.ts`; see upstream issue #2782 |


## Break-it exercises for later phases

- Open two editors for the same definition. Save a change, delete and recreate the agent with the same slug in the other window, then submit the stale edit. The guarded writer must preserve the replacement definition and its binding.
- Change the active subscription account between save and launch, then make the vault temporarily unreadable. Distinguish missing authorization from a temporary fault. Stop during the retry and verify that no other account incurs a request.
- Label a task with another model's name while running an explicitly mapped subscription. Compare the requested model, selected model, configured effort and actual provider response. Check a CLI alias, missing provider metadata and a role with the same name as a model.
- Park a worker on its second fallback. Change the shared class, saved binding and chat override before restarting. Deliver two independent wake notifications. Check execution generation, workspace identity, progress, candidate position, actual invocation count and new-job selection.
- Import a file declaring tiers, edit the binding in the profile, then republish the original file. Verify the conflict is visible, the owner's edit survives, and a subsequent approved replacement targets the same definition and package version.
- Upgrade and downgrade a fixture with customized prompts, hidden or deleted built-ins, old slugs in historical jobs, name collisions and a waiting worker. Repeat the operation and compare stable identifiers and history.
