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

    <!-- Structured sales page (manifest.page), in the approved order.
         Missing pieces are skipped, never shown as placeholders. -->
    <article
      v-if="page"
      class="copy"
      @click="onCopyClick"
    >
      <div
        v-if="page.results"
        class="testi"
      >
        {{ page.results }}
      </div>

      <h2
        v-if="page.headline"
        class="hl"
      >
        {{ page.headline }}
      </h2>
      <p
        v-if="page.subhead"
        class="sub"
      >
        {{ page.subhead }}
      </p>

      <!-- eslint-disable vue/no-v-html -- sanitized via DOMPurify -->
      <div
        v-if="storyHtml"
        class="md"
        v-html="storyHtml"
      />
      <!-- eslint-enable vue/no-v-html -->

      <ul
        v-if="page.imagine.length"
        class="imagine"
      >
        <li
          v-for="(line, i) in page.imagine"
          :key="i"
        >
          {{ line }}
        </li>
      </ul>

      <blockquote
        v-if="firstQuote"
        class="testi quote"
      >
        <p>“{{ firstQuote.quote }}”</p>
        <footer v-if="firstQuote.name">
          {{ quoteBy(firstQuote) }}
        </footer>
      </blockquote>

      <hr
        v-if="page.offer || page.benefits.length"
        class="sep"
      >
      <div
        v-if="page.offer || page.benefits.length"
        class="offer-card"
      >
        <template v-if="page.offer">
          <h2
            v-if="page.offer.title"
            class="center"
          >
            {{ page.offer.title }}
          </h2>
          <p
            v-if="page.offer.tagline"
            class="center sub"
          >
            {{ page.offer.tagline }}
          </p>
          <p
            v-if="page.offer.perfectFor"
            class="center"
          >
            {{ perfectFor }}
          </p>
        </template>

        <template v-if="page.benefits.length">
          <h3 class="lead-in">
            You'll be able to:
          </h3>
          <ul class="bens">
            <li
              v-for="(b, i) in page.benefits"
              :key="i"
            >
              <b>{{ b.title }}</b>
              <span v-if="b.note">{{ b.note }}</span>
            </li>
          </ul>
        </template>
      </div>

      <PackageValueStack
        v-if="page.valueStack"
        :stack="page.valueStack"
        :name="row.name"
        :installed="installed"
        :busy="busy"
        @get="onGet"
      />

      <template v-if="page.inside.length">
        <h3 class="lead-in">
          What's inside
        </h3>
        <div class="inside">
          <div
            v-for="(t, i) in page.inside"
            :key="i"
          >
            <b>{{ t.icon ? `${t.icon} ` : '' }}{{ t.title }}</b>
            <span v-if="t.text">{{ t.text }}</span>
          </div>
        </div>
      </template>
      <p
        v-if="page.needs"
        class="fine"
      >
        {{ page.needs }}
      </p>

      <template v-if="page.steps.length">
        <hr class="sep">
        <h2>When you get {{ row.name }}</h2>
        <ol class="steps">
          <li
            v-for="(s, i) in page.steps"
            :key="i"
          >
            <div>
              <b v-if="s.title">{{ s.title }}</b> {{ s.text }}
            </div>
          </li>
        </ol>
      </template>

      <PackageValueStack
        v-if="page.valueStack"
        :stack="page.valueStack"
        :name="row.name"
        :installed="installed"
        :busy="busy"
        @get="onGet"
      />

      <template v-if="page.guarantee">
        <hr class="sep">
        <h2>{{ page.guarantee.title || 'Your no-risk promise' }}</h2>
        <p v-if="page.guarantee.text">
          {{ page.guarantee.text }}
        </p>
      </template>

      <blockquote
        v-for="(t, i) in laterQuotes"
        :key="`q${i}`"
        class="testi quote"
      >
        <p>“{{ t.quote }}”</p>
        <footer v-if="t.name">
          {{ quoteBy(t) }}
        </footer>
      </blockquote>

      <template v-if="page.faq.length">
        <hr class="sep">
        <h2>Frequently asked questions</h2>
        <p
          v-for="(f, i) in page.faq"
          :key="i"
        >
          <b>{{ f.q }}</b><br>{{ f.a }}
        </p>
      </template>

      <template v-if="page.desk">
        <hr class="sep">
        <div class="desk">
          <p
            v-if="page.desk.from"
            class="from"
          >
            {{ deskFrom }}<template v-if="page.desk.place">
              <br><span>{{ page.desk.place }}</span>
            </template>
          </p>
          <h3 v-if="page.desk.headline">
            {{ page.desk.headline }}
          </h3>
          <!-- eslint-disable vue/no-v-html -- sanitized via DOMPurify -->
          <div
            v-if="deskHtml"
            class="md"
            v-html="deskHtml"
          />
          <!-- eslint-enable vue/no-v-html -->
          <p v-if="page.desk.signoff">
            {{ page.desk.signoff }}
          </p>
          <p
            v-if="page.desk.name"
            class="sig"
          >
            {{ page.desk.name }}<template v-if="page.desk.title">
              <br><span>{{ page.desk.title }}</span>
            </template>
          </p>
        </div>
      </template>

      <PackageValueStack
        v-if="page.valueStack"
        :stack="page.valueStack"
        :name="row.name"
        :installed="installed"
        :busy="busy"
        @get="onGet"
      />
    </article>

    <!-- No structured page: the sales page body from description_md.
         Links to #get (and any "YES! …" link) act as the Get button. -->
    <!-- eslint-disable vue/no-v-html -- sanitized via DOMPurify -->
    <article
      v-else-if="bodyHtml"
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
            <p
              v-if="g.blurb"
              class="blurb"
            >
              {{ g.blurb }}
            </p>
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

import PackageValueStack from '@pkg/components/routines/PackageValueStack.vue';
import { marketplaceKindLabel, normalizeMarketplaceKind } from '@pkg/composables/marketplaceKinds';
import { toPackagePage } from '@pkg/composables/packagePage';
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

function renderMd(md: string): string {
  if (!md) return '';
  const html = DOMPurify.sanitize(marked.parse(md, { async: false }));
  // Mark the CTA links so they render as buttons.
  const doc = new DOMParser().parseFromString(`<div>${ html }</div>`, 'text/html');
  doc.querySelectorAll('a').forEach((a) => {
    if (isGetLink(a)) a.classList.add('cta');
  });

  return doc.body.firstElementChild?.innerHTML ?? html;
}

const bodyHtml = computed(() => renderMd(props.detail.descriptionMd));

// Structured sales page from manifest.page; null → description_md above.
const page = computed(() => toPackagePage(props.detail.manifest ?? {}));
const storyHtml = computed(() => renderMd(page.value?.storyMd ?? ''));
const deskHtml = computed(() => renderMd(page.value?.desk?.bodyMd ?? ''));
const firstQuote = computed(() => page.value?.testimonials[0] ?? null);
const laterQuotes = computed(() => page.value?.testimonials.slice(1) ?? []);
const perfectFor = computed(() => {
  const text = page.value?.offer?.perfectFor ?? '';

  return /^perfect for\b/i.test(text) ? text : `Perfect for ${ text }`;
});
const deskFrom = computed(() => {
  const from = page.value?.desk?.from ?? '';

  return /^from the desk of\b/i.test(from) ? from : `From the desk of ${ from }`;
});

function quoteBy(t: { name: string; role: string }): string {
  return [t.name, t.role].filter(Boolean).join(', ');
}

function onGet() {
  if (!props.installed && !props.busy) emit('get');
}

function onCopyClick(ev: MouseEvent) {
  const a = (ev.target as HTMLElement | null)?.closest('a');
  if (!a) return;
  ev.preventDefault();
  if (a.classList.contains('cta')) {
    onGet();

    return;
  }
  const href = a.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href)) window.open(href, '_blank');
}

// One line per kind in "For the curious", as in the approved page.
const KIND_BLURBS: Record<string, string> = {
  agent:       'The teammate you talk to.',
  routine:     'The jobs that run on a schedule.',
  skill:       'Know-how the agent uses.',
  function:    'Small programs it can run for you.',
  integration: 'The accounts and apps it connects to.',
  recipe:      'Apps that run in a container on your machine.',
};

const contentGroups = computed(() => {
  const byKind = new Map<string, string[]>();
  for (const item of props.detail.contents) {
    const names = byKind.get(item.kind) ?? [];
    names.push(item.name || item.slug);
    byKind.set(item.kind, names);
  }

  return [...byKind.entries()].map(([kind, names]) => {
    const label = marketplaceKindLabel(kind, names.length > 1);

    const blurb = KIND_BLURBS[normalizeMarketplaceKind(kind) ?? ''] ?? '';

    return { kind, label, names, blurb, count: `${ names.length } ${ label.toLowerCase() }` };
  });
});
</script>

<style scoped>
.pk-page {
  container: pk-page / inline-size;
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

/* structured sales page (manifest.page) — approved /v2/package components */
.copy .testi {
  margin: 26px 0;
  padding: 18px 20px;
  border: 1.5px dashed var(--nx-hair-strong, var(--border-default));
  border-radius: 14px;
  color: var(--nx-read-3, var(--text-muted));
  font-style: italic;
  text-align: center;
}
.copy .testi.quote p { margin: 0; }
.copy .testi.quote footer { margin-top: 8px; font-style: normal; font-size: 14px; font-weight: 600; color: var(--nx-read-2, var(--text-secondary)); }
.copy .hl { margin: 10px 0 0; font-size: 30px; line-height: 1.2; }
.copy .sub { margin-top: 8px; font-size: 18px; color: var(--nx-read-3, var(--text-muted)); }
.copy .center { text-align: center; }
.copy .sep { margin: 28px 0; border: 0; border-top: 1px solid var(--nx-hair-strong, var(--border-default)); }
.copy h2 {
  margin: 34px 0 0;
  font-size: 26px;
  line-height: 1.25;
  font-weight: 800;
  color: var(--nx-read-1, var(--text-primary));
}
.copy .sep + h2 { margin-top: 0; }
.copy .lead-in { margin: 26px 0 0; font-size: 17px; font-weight: 700; color: var(--nx-read-1, var(--text-primary)); }
.copy .imagine { margin: 14px 0 0; padding-left: 20px; line-height: 1.9; font-weight: 600; color: var(--nx-read-1, var(--text-primary)); }
.copy .imagine li { margin-top: 0; }
.copy .offer-card {
  margin-top: 8px;
  padding: 26px 28px 24px;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-top: 4px solid var(--nx-accent, var(--accent-primary));
  border-radius: 16px;
  box-shadow: 0 1px 2px var(--nx-hair, rgba(0, 0, 0, 0.06)), 0 12px 32px -12px var(--nx-hair-strong, rgba(0, 0, 0, 0.16));
}
.copy .offer-card > h2:first-child { margin-top: 0; }
.copy .offer-card .lead-in { margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--nx-hair-strong, var(--border-default)); }
@media (max-width: 640px) { .copy .offer-card { padding: 20px 18px; } }
.copy .bens { list-style: none; display: grid; gap: 12px; margin: 10px 0 0; padding: 0; }
.copy .bens li { margin: 0; }
.copy .bens b { display: block; font-size: 17px; line-height: 1.45; color: var(--nx-read-1, var(--text-primary)); }
.copy .bens span { font-size: 14px; color: var(--nx-read-3, var(--text-muted)); }
.copy .inside { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.copy .inside div {
  padding: 14px 16px;
  font-size: 14px;
  line-height: 1.55;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 12px;
}
.copy .inside b { display: block; margin-bottom: 2px; color: var(--nx-read-1, var(--text-primary)); }
.copy .inside span { color: var(--nx-read-3, var(--text-muted)); }
.copy .steps { list-style: none; counter-reset: s; display: grid; gap: 12px; margin: 14px 0 0; padding: 0; }
.copy .steps li { counter-increment: s; display: grid; grid-template-columns: 32px 1fr; gap: 12px; align-items: start; margin: 0; }
.copy .steps li::before {
  content: counter(s);
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 700;
  background: color-mix(in srgb, var(--nx-accent, #5096b3) 15%, transparent);
  color: var(--nx-accent-2, var(--accent-primary));
}
.copy .desk {
  padding: 24px 26px;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 16px;
}
.copy .desk .from { margin-top: 0; font-weight: 700; color: var(--nx-read-1, var(--text-primary)); }
.copy .desk .from span,
.copy .desk .sig span { font-weight: 400; font-family: var(--font-body, system-ui, sans-serif); font-size: 15px; color: var(--nx-read-3, var(--text-muted)); }
.copy .desk h3 { margin-top: 10px; font-size: 22px; line-height: 1.3; }
.copy .desk .sig { font-family: 'Brush Script MT', 'Segoe Script', 'Snell Roundhand', cursive; font-size: 22px; font-weight: 700; color: var(--nx-read-1, var(--text-primary)); }
.copy .fine { font-size: 13px; }
@container pk-page (max-width: 640px) {
  .copy .inside { grid-template-columns: 1fr; }
  .copy .hl { font-size: 26px; }
  .copy .desk { padding: 20px; }
}

.blurb { margin: 2px 0 0; font-size: 13px; color: var(--nx-read-3, var(--text-muted)); }

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
