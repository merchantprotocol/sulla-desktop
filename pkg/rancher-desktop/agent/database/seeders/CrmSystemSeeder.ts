/**
 * CrmSystemSeeder — INTENTIONALLY INERT (no default record types).
 *
 * ⚠️ 2026-06-24 — Jonathon rejected auto-seeding generic record types.
 * An earlier version of this seeder created `company`, `person`, and
 * `engagement` (a deal pipeline). That was wrong: the real Sulla product CRM
 * (Mobile/Cloud) already owns **Contact** records and **three deal pipelines —
 * Opportunities, Appointments, Jobs**. Seeding generic types here duplicates
 * and collides with concepts the product already has.
 *
 * The dynamic record ENGINE (migrations 0029–0036 + CrmSchemaService) stays —
 * it is for NET-NEW custom record types a user/AI defines at runtime. It must
 * NOT ship a generic default CRM. So this seeder no longer seeds anything.
 *
 * OPEN FORK (pending Jonathon's confirmation — do not presume):
 *   (A) additive-only: the dynamic system seeds nothing; users/AI create types
 *       on demand.                                            ← current behavior
 *   (B) mirror the real product's 3 pipelines (Opportunities/Appointments/Jobs)
 *       into the dynamic model as system types.
 * When (B) is chosen, re-enable seeding here against those REAL pipelines —
 * not invented generics. The Company/Person/Engagement worked example is
 * preserved purely as an API illustration in
 * projects/sulla-crm-dynamic-architecture/03-SYSTEM-SEED.md.
 *
 * Kept registered (a harmless no-op) so the wiring exists for fork (B).
 */

async function initialize(): Promise<void> {
  console.log('[CrmSystemSeeder] Inert by design — dynamic CRM seeds no default record types '
    + '(generic seed rejected 2026-06-24; awaiting A/B fork decision).');
}

export { initialize };
