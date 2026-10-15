<template>
  <div class="pk-page">
    <button
      type="button"
      class="back"
      @click="$emit('close')"
    >
      ← All use cases
    </button>

    <div class="crumbs">
      Use Cases<template v-if="topicLabel">
        › {{ topicLabel }}
      </template> › {{ row.title }}
    </div>

    <header class="pk-hero">
      <div class="pk-badge">
        <div class="pkg-ic">
          {{ row.icon }}
        </div>
        <span>{{ row.name }}<template v-if="appBadge"> · {{ appBadge }}</template></span>
      </div>
      <h1>{{ row.title }}</h1>
      <p
        v-if="row.line"
        class="lede"
      >
        {{ row.line }}
      </p>
      <div class="get-row">
        <template v-if="installed">
          <span class="state ok">✓ Installed</span>
          <button
            type="button"
            class="btn ghost"
            :disabled="busy"
            @click="$emit('uninstall')"
          >
            {{ busy ? 'Removing…' : 'Remove' }}
          </button>
        </template>
        <button
          v-else
          type="button"
          class="btn"
          :disabled="busy"
          @click="$emit('get')"
        >
          {{ busy ? 'Getting…' : `Get ${row.name}` }}
        </button>
      </div>
      <p class="fine">
        Free. One click installs everything it needs. Remove it any time and what it added comes off with it.
      </p>
    </header>

    <!-- Sales page body from the use case's description_md. Links to
         #get (and any "YES! …" link) act as the Get button. -->
    <!-- eslint-disable vue/no-v-html -- sanitized via DOMPurify -->
    <article
      v-if="bodyHtml"
      class="copy"
      @click="onCopyClick"
      v-html="bodyHtml"
    />
    <!-- eslint-enable vue/no-v-html -->

    <details
      v-if="contentGroups.length"
      class="more"
    >
      <summary>For the curious: what's in the use case</summary>
      <div class="rows">
        <div
          v-for="g in contentGroups"
          :key="g.kind"
          class="row"
        >
          <div>
            <b>{{ g.label }}</b> · {{ g.names.join(', ') }}
          </div>
          <span class="tag">{{ g.count }}</span>
        </div>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed } from 'vue';

import { marketplaceKindLabel } from '@pkg/composables/marketplaceKinds';
import { packageTopicLabel } from '@pkg/composables/packageTopics';
import type { PackageDetail } from '@pkg/composables/usePackages';

const props = defineProps<{
  detail:    PackageDetail;
  installed: boolean;
  busy:      boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'get'): void;
  (e: 'uninstall'): void;
}>();

const row = computed(() => props.detail.row);
const topicLabel = computed(() => packageTopicLabel(row.value.topic));

const appBadge = computed(() => {
  if (row.value.app === 'dashboard') return 'Includes a dashboard';
  if (row.value.app === 'app') return 'Includes an app';

  return '';
});

function isGetLink(a: HTMLAnchorElement): boolean {
  const href = (a.getAttribute('href') ?? '').trim().toLowerCase();

  return href === '#get' || /^yes!/i.test((a.textContent ?? '').trim());
}

const bodyHtml = computed(() => {
  const md = props.detail.descriptionMd;
  if (!md) return '';
  const html = DOMPurify.sanitize(marked.parse(md, { async: false }));
  // Mark the CTA links so they render as buttons.
  const doc = new DOMParser().parseFromString(`<div>${ html }</div>`, 'text/html');
  doc.querySelectorAll('a').forEach((a) => {
    if (isGetLink(a)) a.classList.add('cta');
  });

  return doc.body.firstElementChild?.innerHTML ?? html;
});

function onCopyClick(ev: MouseEvent) {
  const a = (ev.target as HTMLElement | null)?.closest('a');
  if (!a) return;
  ev.preventDefault();
  if (a.classList.contains('cta')) {
    if (!props.installed && !props.busy) emit('get');

    return;
  }
  const href = a.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href)) window.open(href, '_blank');
}

const contentGroups = computed(() => {
  const byKind = new Map<string, string[]>();
  for (const item of props.detail.contents) {
    const names = byKind.get(item.kind) ?? [];
    names.push(item.name || item.slug);
    byKind.set(item.kind, names);
  }

  return [...byKind.entries()].map(([kind, names]) => {
    const label = marketplaceKindLabel(kind, names.length > 1);

    return { kind, label, names, count: `${ names.length } ${ label.toLowerCase() }` };
  });
});
</script>

<style scoped>
.pk-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 8px 0 48px;
  color: var(--nx-read-1, var(--text-primary));
  font-family: var(--font-body, system-ui, sans-serif);
}
.back {
  font: inherit;
  font-size: 14px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--nx-accent-2, var(--accent-primary));
  cursor: pointer;
}
.crumbs { margin-top: 14px; font-size: 13px; color: var(--nx-read-3, var(--text-muted)); }

.pk-hero { margin-top: 18px; }
.pk-badge { display: inline-flex; gap: 10px; align-items: center; font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.pkg-ic {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--nx-surface, var(--bg-surface));
  display: grid;
  place-items: center;
  font-size: 20px;
}
.pk-hero h1 {
  margin: 14px 0 0;
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 38px;
  line-height: 1.1;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--nx-read-1, var(--text-primary));
}
.lede { margin: 12px 0 0; font-size: 18px; line-height: 1.55; color: var(--nx-read-2, var(--text-secondary)); }
.get-row { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; align-items: center; }
.fine { margin: 10px 0 0; font-size: 13px; color: var(--nx-read-3, var(--text-muted)); }
.state.ok { color: var(--nx-success, var(--text-success)); font-weight: 600; font-size: 15px; }

.btn,
.copy :deep(a.cta) {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  padding: 12px 22px;
  border: 0;
  border-radius: 999px;
  background: var(--nx-accent, var(--accent-primary));
  color: var(--text-on-accent, #fff);
  text-decoration: none;
  cursor: pointer;
}
.btn:hover:not(:disabled),
.copy :deep(a.cta:hover) { background: var(--nx-accent-2, var(--accent-primary-hover)); }
.btn:disabled { opacity: 0.6; cursor: progress; }
.btn.ghost {
  background: transparent;
  color: var(--nx-read-2, var(--text-secondary));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
}

/* markdown body — approved long-form package page */
.copy { margin-top: 36px; font-size: 16px; line-height: 1.7; color: var(--nx-read-2, var(--text-secondary)); }
.copy :deep(p) { margin: 14px 0 0; }
.copy :deep(h1),
.copy :deep(h2) {
  margin: 34px 0 0;
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 26px;
  line-height: 1.25;
  font-weight: 800;
  color: var(--nx-read-1, var(--text-primary));
}
.copy :deep(h3) { margin: 26px 0 0; font-size: 19px; font-weight: 700; color: var(--nx-read-1, var(--text-primary)); }
.copy :deep(strong) { color: var(--nx-read-1, var(--text-primary)); }
.copy :deep(a:not(.cta)) { color: var(--nx-accent-2, var(--accent-primary)); }
.copy :deep(a.cta) { box-sizing: border-box; width: 100%; margin-top: 14px; }
.copy :deep(ul),
.copy :deep(ol) { margin: 14px 0 0; padding-left: 22px; }
.copy :deep(li) { margin-top: 6px; }
.copy :deep(hr) { margin: 36px 0; border: 0; border-top: 1px solid var(--nx-hair-strong, var(--border-default)); }
.copy :deep(blockquote) {
  margin: 26px 0;
  padding: 18px 20px;
  border: 1.5px dashed var(--nx-hair-strong, var(--border-default));
  border-radius: 14px;
  color: var(--nx-read-3, var(--text-muted));
  font-style: italic;
  text-align: center;
}
.copy :deep(blockquote p) { margin: 0; }
/* value stack: a two-column markdown table */
.copy :deep(table) {
  width: 100%;
  margin-top: 26px;
  border-collapse: collapse;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 16px;
  overflow: hidden;
  font-size: 15px;
}
.copy :deep(th),
.copy :deep(td) { padding: 10px 18px; text-align: left; border-bottom: 1px solid var(--nx-hair, var(--border-subtle)); }
.copy :deep(td:last-child),
.copy :deep(th:last-child) { text-align: right; white-space: nowrap; }
.copy :deep(tr:last-child td) { border-bottom: 0; font-weight: 800; color: var(--nx-accent-2, var(--accent-primary)); }
.copy :deep(del) { color: var(--nx-read-3, var(--text-muted)); }
.copy :deep(code) { font-family: var(--font-mono, monospace); font-size: 0.9em; }

details.more {
  margin-top: 36px;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 14px;
  padding: 16px 18px;
}
details.more summary { cursor: pointer; font-weight: 700; color: var(--nx-read-1, var(--text-primary)); }
details.more[open] summary { margin-bottom: 10px; }
.rows { display: grid; }
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  font-size: 14px;
  border-top: 1px solid var(--nx-hair, var(--border-subtle));
  color: var(--nx-read-2, var(--text-secondary));
}
.row b { color: var(--nx-read-1, var(--text-primary)); }
.tag {
  font-size: 12px;
  white-space: nowrap;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  color: var(--nx-read-3, var(--text-muted));
  align-self: start;
}
</style>
