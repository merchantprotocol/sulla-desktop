// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

interface TokenizerJson {
  model?: { vocab?: Record<string, number> };
  added_tokens?: Array<{ id: number; content: string; special?: boolean }>;
}

/** Decodes Whisper's GPT-2 byte-level BPE token ids without a runtime package. */
export class WhisperTokenizerDecoder {
  private readonly tokenById = new Map<number, string>();
  private readonly ignoredIds = new Set<number>();
  private readonly byteByCharacter = new Map<string, number>();

  constructor(tokenizerJson: string) {
    const tokenizer = JSON.parse(tokenizerJson) as TokenizerJson;
    for (const [token, id] of Object.entries(tokenizer.model?.vocab ?? {})) this.tokenById.set(id, token);
    for (const token of tokenizer.added_tokens ?? []) {
      this.tokenById.set(token.id, token.content);
      if (token.special) this.ignoredIds.add(token.id);
    }
    this.buildByteDecoder();
  }

  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      if (this.ignoredIds.has(id)) continue;
      const token = this.tokenById.get(id);
      if (token === undefined) throw new Error(`Unknown Whisper tokenizer id: ${id}`);
      for (const character of token) {
        const byte = this.byteByCharacter.get(character);
        if (byte === undefined) throw new Error(`Invalid byte-level BPE character: ${character}`);
        bytes.push(byte);
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
  }

  private buildByteDecoder(): void {
    const bytes: number[] = [];
    for (let value = 33; value <= 126; value++) bytes.push(value);
    for (let value = 161; value <= 172; value++) bytes.push(value);
    for (let value = 174; value <= 255; value++) bytes.push(value);
    const codePoints = [...bytes];
    let extra = 0;
    for (let value = 0; value < 256; value++) {
      if (bytes.includes(value)) continue;
      bytes.push(value);
      codePoints.push(256 + extra++);
    }
    bytes.forEach((value, index) => this.byteByCharacter.set(String.fromCodePoint(codePoints[index]), value));
  }
}
