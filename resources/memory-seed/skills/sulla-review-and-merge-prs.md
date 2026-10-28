---
slug: sulla-review-and-merge-prs
label: Review, order and merge pull requests safely
trigger_when: When someone asks you to review a pull request, resolve its conflicts, merge the ready pull requests, assemble a release, or draft release notes.
trigger_actions: [review a pull request, resolve merge conflicts, merge pull requests, prepare a release]
trigger_phrases: [review this pull request, merge all the PRs that are ready, resolve the merge conflicts, bring every PR that should ship into one release, cut a release, write the release notes]
scope: [tool-github]
---

**When:** Use this to review one PR or coordinate several PRs into a release. Merging and publishing are external actions, so prepare everything first and get one explicit approval.

**Do:**
1. List every candidate page: `sulla github/list_prs '{"owner":"<owner>","repo":"<repo>","state":"open","base":"<base>","limit":100,"page":1}'`. Follow its next-page instruction until no page remains.
2. For each candidate, read metadata and the exact file set: `sulla github/get_pr '{"owner":"<owner>","repo":"<repo>","pull_number":1}'` and `sulla github/get_pr_files '{"owner":"<owner>","repo":"<repo>","pull_number":1}'`. Read relevant changed files and repository rules; do not review only titles or summaries.
3. Check reviews and CI against the PR's current head SHA: `sulla github/list_pr_reviews '{"owner":"<owner>","repo":"<repo>","pull_number":1}'` and `sulla github/check_runs '{"owner":"<owner>","repo":"<repo>","ref":"<head-sha>"}'`. Use `sulla github/ci_logs '{"owner":"<owner>","repo":"<repo>","ref":"<head-sha>","failedOnly":true,"maxLines":120}'` for failures.
4. Report findings by severity with file and line evidence. A review submission posts externally: prepare the body, ask once with `ask_user_question`, then use `sulla github/add_pr_review '{"owner":"<owner>","repo":"<repo>","pull_number":1,"event":"COMMENT","body":"<review>"}'` only after approval.
5. For a conflict, fetch the repository, create an isolated worktree for the PR branch, merge or rebase the latest base using the repository's documented strategy, then run `sulla github/git_conflicts '{"absolutePath":"<worktree>"}'`. Resolve every listed file, run relevant checks, commit, and push. Never force-push a branch you do not own.
6. Re-read every PR after fixes. Exclude drafts, requested changes, failing or missing required checks, stale heads, and unresolved conflicts. Order the remainder by dependencies, schema compatibility, and shared files. Merge foundations before dependents.
7. Prepare a table of PR number, title, head SHA, checks, reviews, merge method, and order. Ask once with `ask_user_question` for the exact merge set and any release publication.
8. After approval, re-read the first PR and merge its verified SHA: `sulla github/merge_pr '{"owner":"<owner>","repo":"<repo>","pull_number":1,"sha":"<head-sha>","merge_method":"squash","confirm":true}'`. Repeat the CI and head checks before each later merge because the base changed.
9. Check the base after the last merge: `sulla github/check_runs '{"owner":"<owner>","repo":"<repo>","ref":"<base>"}'`. If it fails, stop the sequence and investigate before merging more.
10. Draft a release safely with `sulla github/create_release '{"owner":"<owner>","repo":"<repo>","tag_name":"<tag>","target_commitish":"<base>","name":"<name>","body":"<verified notes>","draft":true}'`. Publishing the release requires a new explicit go-ahead and `"confirm":true`.

**Check:** Every merged SHA was re-read immediately before merging, required checks were green on that SHA, the base branch is healthy afterward, and release notes describe only changes actually included.

**Don't:**
- Don't approve your own work as an independent review or treat a green check as a code review.
- Don't batch-merge from a stale list. The base and mergeability can change after every merge.
- Don't merge, post a review, publish a release, close a PR, or delete a branch before explicit approval.
