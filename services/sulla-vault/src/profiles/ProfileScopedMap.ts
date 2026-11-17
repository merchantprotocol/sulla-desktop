// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** In-memory profile-keyed map that presents the original local key to its single-profile owner. */
export class ProfileScopedMap<Value> extends Map<string, Value> {
  constructor(private readonly profileId: string) { super(); }

  private scopedKey(key: string): string { return `${this.profileId}\0${key}`; }

  override get(key: string): Value | undefined { return super.get(this.scopedKey(key)); }
  override set(key: string, value: Value): this { super.set(this.scopedKey(key), value); return this; }
  override has(key: string): boolean { return super.has(this.scopedKey(key)); }
  override delete(key: string): boolean { return super.delete(this.scopedKey(key)); }

  override get size(): number {
    let count = 0;
    for (const _key of this.keys()) count += 1;
    return count;
  }

  override forEach(callbackfn: (value: Value, key: string, map: Map<string, Value>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this);
  }

  override clear(): void {
    for (const key of super.keys()) if (key.startsWith(`${this.profileId}\0`)) super.delete(key);
  }

  override *keys(): IterableIterator<string> {
    for (const key of super.keys()) if (key.startsWith(`${this.profileId}\0`)) yield key.slice(this.profileId.length + 1);
  }

  override *values(): IterableIterator<Value> {
    for (const key of super.keys()) if (key.startsWith(`${this.profileId}\0`)) yield super.get(key)!;
  }

  override *entries(): IterableIterator<[string, Value]> {
    for (const key of super.keys()) if (key.startsWith(`${this.profileId}\0`)) yield [key.slice(this.profileId.length + 1), super.get(key)!];
  }

  override [Symbol.iterator](): IterableIterator<[string, Value]> { return this.entries(); }
}
