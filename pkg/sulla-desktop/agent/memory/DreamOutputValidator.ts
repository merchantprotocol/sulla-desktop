// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  DreamBatch, DreamContext, DreamWriteEvidence, DreamWriteItem, ValidatedDreamWrite,
} from './V7Dreamer';

/** Validates the model's data-only reply. Ids, ts and always_on are assigned here, never by the model. */
export class DreamOutputValidator {
  static readonly MAX_OUTPUT_ITEMS = 10;
  static readonly MAX_EVIDENCE_PER_ITEM = 10;
  static readonly ITEM_TYPES: ReadonlySet<string> = new Set(['do', 'dont', 'preference', 'direction', 'lesson']);
  static readonly EVIDENCE_ROLES: ReadonlySet<string> = new Set(['origin', 'reinforces', 'contradicts']);

  validate(raw: string, batch: DreamBatch, context: DreamContext, now: number): ValidatedDreamWrite {
    const root = this.asRecord(this.parse(raw), 'root');
    this.exactKeys(root, ['items'], 'root');
    if (!Array.isArray(root.items) || root.items.length > DreamOutputValidator.MAX_OUTPUT_ITEMS) {
      throw new Error(`items must be an array of at most ${ DreamOutputValidator.MAX_OUTPUT_ITEMS }`);
    }

    const subjects = new Set(context.subjects.map(subject => subject.slug));
    const windowEpisodes = new Set(batch.episodes.map(episode => episode.id));
    // The Dreamer may only replace inferred conclusions, never a rule the human
    // stated or a shipped (seeded) item.
    const replaceable = new Set(context.currentItems.filter(item => item.origin === 'model_inferred').map(item => item.id));
    const superseded = new Set<string>();
    const items: DreamWriteItem[] = [];
    const evidence: DreamWriteEvidence[] = [];

    root.items.forEach((value, index) => {
      const label = `items[${ index }]`;
      const row = this.asRecord(value, label);
      this.exactKeys(row, ['ptype', 'text', 'why', 'scope', 'supersedes', 'evidence'], label);

      const ptype = row.ptype === null || row.ptype === undefined ? null : this.text(row.ptype, `${ label }.ptype`, 32);
      if (ptype !== null && !DreamOutputValidator.ITEM_TYPES.has(ptype)) throw new Error(`${ label }.ptype ${ ptype } is not supported`);

      const scope = this.stringArray(row.scope, `${ label }.scope`, 10);
      if (!scope.length || scope.some(slug => !subjects.has(slug))) throw new Error(`${ label }.scope must name known subjects`);

      const supersedes = row.supersedes === null || row.supersedes === undefined ? null : this.text(row.supersedes, `${ label }.supersedes`, 80);
      if (supersedes !== null) {
        if (!replaceable.has(supersedes)) throw new Error(`${ label }.supersedes must be a current model-inferred conclusion`);
        if (superseded.has(supersedes)) throw new Error(`${ label }.supersedes ${ supersedes } is replaced twice`);
        superseded.add(supersedes);
      }

      if (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > DreamOutputValidator.MAX_EVIDENCE_PER_ITEM) {
        throw new Error(`${ label }.evidence must link 1-${ DreamOutputValidator.MAX_EVIDENCE_PER_ITEM } episodes from this window`);
      }
      const id = `${ now }-dream-${ index + 1 }`;
      const linked = new Set<string>();
      row.evidence.forEach((link, linkIndex) => {
        const linkLabel = `${ label }.evidence[${ linkIndex }]`;
        const record = this.asRecord(link, linkLabel);
        this.exactKeys(record, ['episode_id', 'role'], linkLabel);
        const episodeId = this.text(record.episode_id, `${ linkLabel }.episode_id`, 80);
        const role = this.text(record.role, `${ linkLabel }.role`, 32);
        if (!windowEpisodes.has(episodeId)) throw new Error(`${ linkLabel }.episode_id must be an episode from this window`);
        if (!DreamOutputValidator.EVIDENCE_ROLES.has(role)) throw new Error(`${ linkLabel }.role ${ role } is not supported`);
        if (linked.has(episodeId)) return;
        linked.add(episodeId);
        evidence.push({ item_id: id, episode_id: episodeId, role });
      });

      items.push({
        id,
        ptype,
        text:  this.text(row.text, `${ label }.text`, 2_000),
        why:   row.why === null || row.why === undefined ? null : this.text(row.why, `${ label }.why`, 1_000),
        scope,
        ts:    now,
        supersedes,
      });
    });

    return { items, evidence };
  }

  private parse(response: string): unknown {
    const trimmed = response.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    return JSON.parse(fenced?.[1] ?? trimmed);
  }

  private asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${ label } must be an object`);

    return value as Record<string, unknown>;
  }

  private exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length) throw new Error(`${ label } contains unsupported fields: ${ unexpected.join(', ') }`);
  }

  private text(value: unknown, label: string, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      throw new Error(`${ label } must be a non-empty string of at most ${ max } characters`);
    }

    return value;
  }

  private stringArray(value: unknown, label: string, maxItems: number): string[] {
    if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || !item || item.length > 128)) {
      throw new Error(`${ label } must be an array of at most ${ maxItems } bounded strings`);
    }

    return [...new Set(value as string[])];
  }
}
