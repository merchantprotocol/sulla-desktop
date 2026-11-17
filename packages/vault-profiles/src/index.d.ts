// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export declare class ProfileId { readonly value: string; constructor(value: string); toString(): string }
export declare class ProfileGeneration { readonly value: number; constructor(value: number); toString(): string }
export type ProfileMigrationState = 'unmigrated' | 'pending' | 'complete' | 'failed';
export declare class ProfileCatalogEntry {
  readonly profileId: ProfileId; readonly cloudUserId: string; readonly dbIdentifier: string;
  readonly displayLabel: string; readonly migrationState: ProfileMigrationState; readonly generation: ProfileGeneration;
  constructor(input: { cloudUserId: string; displayLabel: string; migrationState?: ProfileMigrationState; generation?: number });
  toJSON(): { profileId: string; cloudUserId: string; dbIdentifier: string; displayLabel: string; migrationState: ProfileMigrationState; generation: number };
}
export declare class ProfileBoundary {
  resolve(entries: readonly (ProfileCatalogEntry | Record<string, unknown>)[], profileId: string): ProfileCatalogEntry | Record<string, unknown>;
  assertCurrent(requestGeneration: number | ProfileGeneration, activeGeneration: number | ProfileGeneration): void;
  assertCollisionSafe(entries: readonly Record<string, unknown>[]): void;
  serializeLogDto(input: { profileId: string | ProfileId; generation: number | ProfileGeneration; event: string }): Readonly<{ profileId: string; generation: number; event: string }>
  serializeCatalogEntry(entry: ProfileCatalogEntry | Record<string, unknown>): Readonly<Record<string, unknown>>;
}
