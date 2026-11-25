// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJobCheckin } from '@pkg/agent/database/models/AgentJobMessagingModel';

export interface TraceImageReference { src: string; alt: string }
export interface TracePayloadPresentation { text: string; images: TraceImageReference[] }

/** A disclosure source. Equal inputs let a mounted row reuse its cached serialization. */
export class TracePayload {
  constructor(
    private readonly inputs: readonly unknown[],
    readonly serialize: (history?: readonly AgentJobCheckin[]) => string,
    readonly load?: () => Promise<unknown>,
  ) {}

  matches(other: TracePayload): boolean {
    return this.inputs.length === other.inputs.length &&
      this.inputs.every((value, index) => Object.is(value, other.inputs[index]));
  }
}

/** Serializes complete recorded trace payloads without modification. */
export class TracePayloadSerializer {
  serialize(value: unknown): string {
    let text: string;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
    return text;
  }

  lazy(value: unknown): TracePayload {
    return new TracePayload([value], () => this.serialize(value));
  }

  present(value: unknown): TracePayloadPresentation {
    let parsed = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value) }
      catch { return { text: value, images: [] } }
    }
    const images: TraceImageReference[] = [];
    return { text: this.serialize(this.imageReferences(parsed, images)), images };
  }

  private imageReferences(value: unknown, images: TraceImageReference[], depth = 0, mediaType = 'image/png'): unknown {
    if (typeof value === 'string') {
      if (/^data:image\//i.test(value)) return this.addImage(images, value);
      if (depth < 3 && /^[\[{]/.test(value.trim())) {
        try { return this.imageReferences(JSON.parse(value), images, depth + 1, mediaType) }
        catch { return value }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.imageReferences(item, images, depth, mediaType));
    if (!value || typeof value !== 'object') return value;
    const source = (value as any).source;
    if ((value as any).type === 'image' && source?.type === 'base64' && typeof source.data === 'string') {
      return this.addImage(images, `data:${ source.media_type || mediaType };base64,${ source.data }`);
    }
    const record = value as Record<string, unknown>;
    const localType = String(record.screenshotMediaType ?? record.imageMediaType ?? record.mimeType ?? mediaType);
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (/^(?:screenshot|image)(?:_?base64|_?data)$/i.test(key) && typeof item === 'string') {
        copy[key] = this.addImage(images, `data:${ localType };base64,${ item }`);
      } else {
        copy[key] = this.imageReferences(item, images, depth, localType);
      }
    }
    return copy;
  }

  private addImage(images: TraceImageReference[], src: string): string {
    const index = images.length + 1;
    images.push({ src, alt: `Tool image ${ index }` });
    return `[Image reference ${ index }]`;
  }

  summary(value: string | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
  }

  preview(value: string | undefined): string {
    // Tool input is already recorded as text. Bound the work before normalizing it.
    return this.summary(value?.slice(0, 300));
  }
}
