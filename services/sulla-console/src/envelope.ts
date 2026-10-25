// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

export interface ApiEnvelope<T> {
  apiVersion: '1';
  orgId: string;
  generatedAt: string;
  data: T;
}

export function envelope<T>(orgId: string, data: T, generatedAt = new Date()): ApiEnvelope<T> {
  return { apiVersion: '1', orgId, generatedAt: generatedAt.toISOString(), data };
}
