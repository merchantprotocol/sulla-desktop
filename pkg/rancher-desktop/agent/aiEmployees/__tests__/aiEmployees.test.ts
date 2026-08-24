/** @jest-environment node */
import { describe, expect, it } from '@jest/globals';

import {
  activateEmployee,
  activationGate,
  buildMarketplaceView,
  canActivate,
  deactivateEmployee,
  listAiEmployees,
  listCategories,
  meetsTier,
} from '../index';
import type { AiEmployee, AiEmployeeActivation } from '../types';

const NOW = '2026-08-24T00:00:00.000Z';

function freeEmployee(): AiEmployee {
  const found = listAiEmployees().find(e => e.requiredTier === 'free' && !e.comingSoon);

  if (!found) {
    throw new Error('expected at least one free, activatable employee in the catalog');
  }

  return found;
}

function gatedEmployee(): AiEmployee {
  const found = listAiEmployees().find(e => e.requiredTier === 'enterprise_gateway' && !e.comingSoon);

  if (!found) {
    throw new Error('expected at least one enterprise-gated employee in the catalog');
  }

  return found;
}

describe('aiEmployees catalog', () => {
  it('exposes a non-empty catalog with unique ids and required fields', () => {
    const all = listAiEmployees();

    expect(all.length).toBeGreaterThan(0);
    const ids = all.map(e => e.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const e of all) {
      expect(e.name).toBeTruthy();
      expect(e.capabilities.length).toBeGreaterThan(0);
      expect(['free', 'premium_support', 'enterprise_gateway']).toContain(e.requiredTier);
    }
  });

  it('derives categories from the catalog', () => {
    expect(listCategories().length).toBeGreaterThan(0);
  });
});

describe('tier eligibility', () => {
  it('higher tiers satisfy lower requirements', () => {
    expect(meetsTier('free', 'enterprise_gateway')).toBe(true);
    expect(meetsTier('enterprise_gateway', 'free')).toBe(false);
    expect(meetsTier('premium_support', 'premium_support')).toBe(true);
  });
});

describe('activation gating', () => {
  it('allows a free employee on the free tier', () => {
    const e = freeEmployee();

    expect(activationGate(e, 'free', [])).toBeNull();
    expect(canActivate(e, 'free', [])).toBe(true);
  });

  it('gates a paid employee behind an upgrade on the free tier', () => {
    const e = gatedEmployee();

    expect(activationGate(e, 'free', [])).toEqual({ kind: 'requires_upgrade', requiredTier: 'enterprise_gateway' });
    expect(canActivate(e, 'free', [])).toBe(false);
  });

  it('reports coming-soon employees as gated even on the top tier', () => {
    const comingSoon = listAiEmployees().find(e => e.comingSoon);

    if (comingSoon) {
      expect(activationGate(comingSoon, 'enterprise_gateway', [])).toEqual({ kind: 'coming_soon' });
    }
  });
});

describe('activation reducers', () => {
  it('activates and is idempotent', () => {
    const e = freeEmployee();
    const once = activateEmployee([], e.id, { at: NOW, by: 'human' });

    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ employeeId: e.id, status: 'active', activatedBy: 'human' });

    const twice = activateEmployee(once, e.id, { at: NOW });

    expect(twice).toBe(once);
  });

  it('throws for unknown employees', () => {
    expect(() => activateEmployee([], 'does-not-exist', { at: NOW })).toThrow();
  });

  it('deactivates idempotently', () => {
    const e = freeEmployee();
    const active: AiEmployeeActivation[] = [{ employeeId: e.id, activatedAt: NOW, status: 'active' }];

    expect(deactivateEmployee(active, e.id)).toHaveLength(0);
    expect(deactivateEmployee([], e.id)).toHaveLength(0);
  });

  it('marks an active employee as already_active', () => {
    const e = freeEmployee();
    const active = activateEmployee([], e.id, { at: NOW });

    expect(activationGate(e, 'free', active)).toEqual({ kind: 'already_active' });
  });
});

describe('marketplace view', () => {
  it('splits available and active with computed gating', () => {
    const e = freeEmployee();
    const activations = activateEmployee([], e.id, { at: NOW });
    const view = buildMarketplaceView({ currentTier: 'free', activations });

    expect(view.available.length).toBe(listAiEmployees().length);
    expect(view.active.map(a => a.employee.id)).toContain(e.id);

    const card = view.available.find(c => c.employee.id === e.id);

    expect(card?.active).toBe(true);
  });
});
