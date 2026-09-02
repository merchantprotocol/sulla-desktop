<template>
  <main
    ref="detailRoot"
    class="issue-detail"
    tabindex="-1"
    aria-labelledby="issue-detail-title"
    @keydown.esc="$emit('close')"
  >
    <header class="issue-topbar">
      <button
        type="button"
        class="back"
        aria-label="Back to Projects"
        @click="$emit('close')"
      >
        ← Projects
      </button>
      <span class="issue-id">ISSUE · {{ taskId }}</span>
      <button
        type="button"
        class="refresh"
        :disabled="loading"
        @click="$emit('refresh')"
      >
        {{ loading ? 'Refreshing…' : '↻ Refresh' }}
      </button>
    </header>

    <div
      v-if="loading && !detail"
      class="issue-state"
      role="status"
    >
      Loading issue and live review state…
    </div>
    <div
      v-else-if="error"
      class="issue-state error"
      role="alert"
    >
      <b>Couldn't load this issue.</b>
      <p>{{ error }}</p>
      <button
        type="button"
        @click="$emit('refresh')"
      >
        Try again
      </button>
    </div>

    <div
      v-else-if="detail"
      class="issue-layout"
    >
      <article class="issue-main">
        <div class="issue-heading">
          <div class="eyebrow">
            {{ projectTitle }} · {{ epicTitle }}
          </div>
          <h1 id="issue-detail-title">
            {{ detail.task.title }}
          </h1>
          <div class="meta">
            <span>{{ statusLabel(detail.task.status) }}</span>
            <span>{{ detail.task.priority }}</span>
            <span v-if="detail.task.assignee">{{ detail.task.assignee }}</span>
            <span v-if="detail.task.github_issue">{{ detail.task.github_issue }}</span>
          </div>
        </div>

        <section
          class="panel description-panel"
          aria-labelledby="primary-description-title"
        >
          <div class="section-title">
            <div>
              <span class="eyebrow">Primary record</span>
              <h2 id="primary-description-title">
                Description
              </h2>
            </div>
            <span class="immutable">Immutable</span>
          </div>
          <div
            class="rich-content"
            v-html="rich(detail.task.description)"
          />
        </section>

        <section
          class="panel thread"
          aria-labelledby="comment-thread-title"
        >
          <div class="section-title">
            <div>
              <span class="eyebrow">Append-only history</span>
              <h2 id="comment-thread-title">
                Comments · {{ detail.comments.length }}
              </h2>
            </div>
          </div>
          <ol
            v-if="detail.comments.length"
            class="comment-list"
          >
            <li
              v-for="comment in detail.comments"
              :key="comment.id"
              class="comment"
            >
              <div class="comment-meta">
                <b>{{ actorLabel(comment.author) }}</b>
                <time :datetime="comment.created_at">{{ shortDate(comment.created_at) }}</time>
              </div>
              <div
                class="rich-content compact"
                v-html="rich(comment.body)"
              />
            </li>
          </ol>
          <p
            v-else
            class="empty"
          >
            No comments yet.
          </p>
          <form
            class="comment-form"
            @submit.prevent="submitComment"
          >
            <label for="issue-comment">Add to the thread</label>
            <textarea
              id="issue-comment"
              v-model="commentDraft"
              rows="4"
              placeholder="Add context or evidence…"
            />
            <div class="form-actions">
              <button
                type="submit"
                :disabled="busy || !commentDraft.trim()"
              >
                Append comment
              </button>
            </div>
          </form>
        </section>
      </article>

      <aside
        class="review-column"
        aria-label="Review brief"
      >
        <section class="panel review-brief">
          <div class="section-title">
            <div><span class="eyebrow">Canonical evidence</span><h2>Review brief</h2></div>
          </div>
          <p
            v-if="!detail.review.pullRequests.length"
            class="empty"
          >
            No pull request is linked to this issue.
          </p>
          <article
            v-for="pull in detail.review.pullRequests"
            :key="`${pull.repository}#${pull.number}`"
            class="pull-card"
          >
            <div class="pull-head">
              <div><b>{{ pull.repository }} #{{ pull.number }}</b><span>{{ pull.title || 'Pull request unavailable' }}</span></div>
              <span
                class="readiness"
                :class="{ ready: pull.mergeReady }"
              >{{ pull.mergeReady ? 'Ready' : 'Not ready' }}</span>
            </div>
            <p
              v-if="pull.error"
              class="inline-error"
            >
              {{ pull.error }}
            </p>
            <dl v-else>
              <div><dt>GitHub</dt><dd>{{ pull.state }}{{ pull.draft ? ' · draft' : '' }}</dd></div>
              <div><dt>Head</dt><dd><code>{{ pull.headSha }}</code></dd></div>
              <div><dt>Branch</dt><dd>{{ pull.headRef }} → {{ pull.baseRef }}</dd></div>
              <div><dt>Mergeable</dt><dd>{{ pull.mergeable === null ? 'unknown' : pull.mergeable ? pull.mergeableState : 'no' }}</dd></div>
            </dl>
            <div
              v-if="pull.checks.length"
              class="evidence-block"
            >
              <h3>Checks</h3>
              <div
                v-for="check in pull.checks"
                :key="check.name"
                class="evidence-row"
              >
                <span>{{ check.name }}</span><b>{{ check.conclusion || check.status }}</b>
              </div>
            </div>
            <p
              v-else-if="!pull.error"
              class="empty small"
            >
              No hosted checks found.
            </p>
            <div
              v-if="pull.reviews.length"
              class="evidence-block"
            >
              <h3>Reviews</h3>
              <div
                v-for="review in pull.reviews"
                :key="`${review.author}-${review.submittedAt}`"
                class="evidence-row"
              >
                <span>{{ review.author }}</span><b>{{ review.state }}</b>
              </div>
            </div>
            <a
              v-if="pull.url"
              :href="pull.url"
              target="_blank"
              rel="noopener noreferrer"
            >Open on GitHub ↗</a>
          </article>

          <EvidenceNotes
            title="Review evidence"
            :items="detail.review.reviewEvidence"
          />
          <EvidenceNotes
            title="Documentation"
            :items="detail.review.documentation"
            empty-label="No documentation notes recorded."
          />
          <EvidenceNotes
            title="Test results"
            :items="detail.review.testResults"
            empty-label="No test results recorded."
          />
          <EvidenceNotes
            title="Risk"
            :items="detail.review.riskNotes"
            empty-label="No explicit risk evidence recorded."
          />
          <EvidenceNotes
            title="Staging"
            :items="detail.review.stagingEvidence"
            empty-label="No staging evidence recorded."
          />
          <EvidenceNotes
            title="Rollback"
            :items="detail.review.rollbackNotes"
            empty-label="No rollback notes recorded."
          />
        </section>

        <section
          v-if="detail.humanGate.active"
          class="panel gate"
          aria-labelledby="human-gate-title"
        >
          <span class="eyebrow">Human-gated stage</span>
          <h2 id="human-gate-title">
            Jonathon's decision
          </h2>
          <p>
            Approval advances from <b>{{ detail.humanGate.currentStage }}</b> to
            <b>{{ detail.humanGate.nextStage || 'no configured next stage' }}</b>. It does not merge or deploy anything.
          </p>
          <label for="gate-reason">Decision note</label>
          <textarea
            id="gate-reason"
            v-model="decisionReason"
            rows="3"
            placeholder="Required when rejecting…"
          />
          <div class="gate-actions">
            <button
              type="button"
              class="approve"
              :disabled="busy || !detail.humanGate.nextStage"
              @click="decide('approved')"
            >
              Approve and advance
            </button>
            <button
              type="button"
              class="reject"
              :disabled="busy || !detail.humanGate.previousStage || !decisionReason.trim()"
              @click="decide('rejected')"
            >
              Reject for repair
            </button>
          </div>
          <p class="gate-footnote">
            The next pipeline stage must revalidate the GitHub head SHA and checks before any merge action.
          </p>
        </section>
      </aside>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import type { WorkCommentRecord } from '@pkg/agent/database/models/WorkItemsModel';
import type { ProjectsIssueDetail } from '@pkg/agent/services/ProjectsIssueDetailService';
import EvidenceNotes from '@pkg/components/projects/ProjectIssueEvidenceNotes.vue';
import { renderProjectRichText } from '@pkg/utils/projectRichText';

const props = defineProps<{
  taskId:       string;
  detail:       ProjectsIssueDetail | null;
  projectTitle: string;
  epicTitle:    string;
  loading:      boolean;
  busy:         boolean;
  error:        string;
  statusLabel:  (status: string) => string;
}>();

const emit = defineEmits<{
  close:   [];
  refresh: [];
  comment: [body: string];
  decide:  [decision: 'approved' | 'rejected', reason: string];
}>();

const detailRoot = ref<HTMLElement | null>(null);
const commentDraft = ref('');
const decisionReason = ref('');

onMounted(() => detailRoot.value?.focus());

function rich(value: string): string { return renderProjectRichText(value) }
function shortDate(iso: string): string { return new Date(iso).toLocaleString() }
function actorLabel(author: WorkCommentRecord['author']): string {
  if (author === 'human') return 'You';
  return author || 'Agent';
}
function submitComment(): void {
  const body = commentDraft.value.trim();
  if (!body || props.busy) return;
  emit('comment', body);
  commentDraft.value = '';
}
function decide(decision: 'approved' | 'rejected'): void {
  if (props.busy) return;
  emit('decide', decision, decisionReason.value.trim());
}
</script>

<style scoped lang="scss">
.issue-detail { position: absolute; inset: 0; z-index: 30; overflow: auto; background: var(--pbg); color: var(--ptext); outline: none; }
.issue-topbar { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; min-height: 58px; padding: 0 28px; border-bottom: 1px solid var(--pborder); background: color-mix(in srgb, var(--pbg) 94%, transparent); backdrop-filter: blur(18px); }
button { border: 1px solid var(--pacc-line); border-radius: 8px; padding: 8px 12px; background: var(--pacc-soft); color: var(--ptext); cursor: pointer; font: 600 12px var(--psans); }
button:focus-visible, a:focus-visible, textarea:focus-visible { outline: 2px solid var(--pacc); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: default; }
.back { justify-self: start; background: transparent; border-color: var(--pborder); }
.refresh { justify-self: end; background: transparent; border-color: var(--pborder); }
.issue-id, .eyebrow { color: var(--ptext3); font: 10px var(--pmono); letter-spacing: .12em; text-transform: uppercase; }
.issue-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 430px); gap: 28px; width: min(1500px, 100%); margin: 0 auto; padding: 38px; }
.issue-main, .review-column { min-width: 0; }
.review-column { display: flex; flex-direction: column; gap: 18px; }
.issue-heading { margin: 0 0 28px; }
h1 { max-width: 980px; margin: 9px 0 14px; font: 500 clamp(30px, 4vw, 54px)/1.08 var(--pserif); }
h2 { margin: 4px 0 0; font: 500 22px var(--pserif); }
h3 { margin: 0 0 8px; font: 600 11px var(--pmono); letter-spacing: .08em; text-transform: uppercase; color: var(--ptext3); }
.meta { display: flex; flex-wrap: wrap; gap: 7px; }
.meta span, .immutable, .readiness { border: 1px solid var(--pborder); border-radius: 999px; padding: 4px 9px; color: var(--ptext2); font: 10px var(--pmono); }
.panel { border: 1px solid var(--pborder); border-radius: 14px; background: var(--psurface); padding: 24px; }
.description-panel { margin-bottom: 20px; }
.section-title, .pull-head, .evidence-row, .form-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.immutable { color: var(--pacc); border-color: var(--pacc-line); }
.rich-content { margin-top: 22px; color: var(--ptext2); font-size: 14px; line-height: 1.72; overflow-wrap: anywhere; }
.rich-content.compact { margin-top: 8px; }
.rich-content :deep(h1), .rich-content :deep(h2), .rich-content :deep(h3) { color: var(--ptext); font-family: var(--pserif); }
.rich-content :deep(a) { color: var(--pacc); }
.rich-content :deep(pre) { overflow: auto; padding: 12px; border: 1px solid var(--pborder); border-radius: 8px; background: var(--pbg); white-space: pre-wrap; }
.rich-content :deep(code) { font-family: var(--pmono); }
.rich-content :deep(table) { width: 100%; border-collapse: collapse; }
.rich-content :deep(td), .rich-content :deep(th) { padding: 7px; border: 1px solid var(--pborder); text-align: left; }
.comment-list { list-style: none; margin: 22px 0 0; padding: 0; }
.comment { padding: 18px 0; border-top: 1px solid var(--pborder-soft); }
.comment-meta { display: flex; justify-content: space-between; gap: 14px; color: var(--ptext3); font: 10px var(--pmono); }
.comment-meta b { color: var(--pacc); }
.comment-form { display: grid; gap: 8px; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--pborder); }
label { color: var(--ptext3); font: 10px var(--pmono); letter-spacing: .08em; text-transform: uppercase; }
textarea { width: 100%; resize: vertical; border: 1px solid var(--pborder); border-radius: 8px; padding: 11px; background: var(--psurface2); color: var(--ptext); font: 13px/1.5 var(--psans); }
.pull-card { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--pborder); }
.pull-head > div { display: grid; gap: 4px; min-width: 0; }
.pull-head span { color: var(--ptext2); font-size: 12px; }
.readiness.ready { color: var(--pgreen); border-color: var(--pgreen); }
dl { display: grid; gap: 8px; margin: 16px 0; }
dl div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; }
dt { color: var(--ptext3); font: 10px var(--pmono); text-transform: uppercase; }
dd { min-width: 0; margin: 0; color: var(--ptext2); font-size: 12px; overflow-wrap: anywhere; }
dd code { font-size: 10px; }
.evidence-block { margin-top: 16px; }
.evidence-row { padding: 6px 0; border-top: 1px solid var(--pborder-soft); color: var(--ptext2); font-size: 11px; }
.evidence-row b { color: var(--ptext); font-family: var(--pmono); }
a { display: inline-block; margin-top: 14px; color: var(--pacc); font-size: 12px; }
.empty { color: var(--ptext3); font-size: 12px; }
.empty.small { margin: 12px 0; }
.inline-error, .issue-state.error { color: var(--pred); }
.gate { border-color: var(--pacc-line); }
.gate p { color: var(--ptext2); font-size: 12px; line-height: 1.55; }
.gate textarea { margin-top: 6px; }
.gate-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.gate-actions .approve { border-color: var(--pgreen); background: var(--pgreen); color: var(--pbg); }
.gate-actions .reject { border-color: var(--pred); background: transparent; color: var(--pred); }
.gate-footnote { padding-top: 12px; border-top: 1px solid var(--pborder); }
.issue-state { display: grid; place-content: center; min-height: 60vh; gap: 8px; text-align: center; }
@media (max-width: 960px) { .issue-layout { grid-template-columns: 1fr; padding: 24px; } }
</style>
