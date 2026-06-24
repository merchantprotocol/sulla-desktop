/**
 * CrmSystemSeeder
 *
 * Seeds the default `is_system` CRM that every install starts with:
 * Company, Person, Engagement (+ their fields/relationships), the four
 * Engagement views that prove the "same record, many views" thesis
 * (Pipeline / Calendar / Jobs / Table), and a starter Sales dashboard.
 *
 * Delivered as a RUNTIME seeder, never baked into a migration (migrations
 * are schema-only; data moves via runtime seeders that read/seed the local
 * install) — honors the no-user-data-in-migrations rule.
 *
 * Idempotent: keyed on (tenant_id, key) via getRecordTypeByKey — re-running
 * is a no-op. Runs after migrations 0029–0035.
 *
 * This seed IS the P1–P4 acceptance test: if it expresses cleanly through
 * CrmSchemaService and the metadata-driven UI renders it with no
 * entity-specific code, the dynamic engine is proven end-to-end.
 *
 * Design: projects/sulla-crm-dynamic-architecture/03-SYSTEM-SEED.md
 */

import { CrmSchemaService, DEFAULT_TENANT_ID } from '../../services/CrmSchemaService';

const sys = { isSystem: true } as const;

async function initialize(): Promise<void> {
  console.log('[CrmSystemSeeder] Seeding default system CRM...');

  // ── already seeded? (idempotent) ───────────────────────────────────────
  const existing = await CrmSchemaService.getRecordTypeByKey('engagement', DEFAULT_TENANT_ID);
  if (existing) {
    console.log('[CrmSystemSeeder] System CRM already seeded — nothing to do');
    return;
  }

  // ── 1. Company ──────────────────────────────────────────────────────────
  const company = await CrmSchemaService.createRecordType({
    key: 'company', label: 'Company', labelPlural: 'Companies',
    icon: 'building', color: '#5096b3', ...sys,
    fields: [
      { key: 'name', label: 'Name', dataType: 'text', isRequired: true, isTitle: true, ...sys },
      { key: 'domain', label: 'Website', dataType: 'url', ...sys },
      { key: 'industry', label: 'Industry', dataType: 'select',
        config: { options: ['Services', 'Retail', 'Construction', 'Food & Bev', 'Tech', 'Other'] }, ...sys },
      { key: 'size', label: 'Size', dataType: 'select',
        config: { options: ['1-10', '11-50', '51-200', '200+'] }, ...sys },
      { key: 'phone', label: 'Phone', dataType: 'phone', ...sys },
      { key: 'address', label: 'Address', dataType: 'long_text', ...sys },
      { key: 'notes', label: 'Notes', dataType: 'long_text', ...sys },
    ],
  });
  if (!company.ok || !company.id) { console.error('[CrmSystemSeeder] company failed:', company.error); return; }

  // ── 2. Person ───────────────────────────────────────────────────────────
  const person = await CrmSchemaService.createRecordType({
    key: 'person', label: 'Person', labelPlural: 'People',
    icon: 'user', color: '#4fae7a', ...sys,
    fields: [
      { key: 'name', label: 'Name', dataType: 'text', isRequired: true, isTitle: true, ...sys },
      { key: 'email', label: 'Email', dataType: 'email', ...sys },
      { key: 'phone', label: 'Phone', dataType: 'phone', ...sys },
      { key: 'title', label: 'Title', dataType: 'text', ...sys },
      { key: 'notes', label: 'Notes', dataType: 'long_text', ...sys },
    ],
  });
  if (!person.ok || !person.id) { console.error('[CrmSystemSeeder] person failed:', person.error); return; }

  await CrmSchemaService.defineRelationship({
    key: 'person_company', fromTypeId: person.id, toTypeId: company.id,
    cardinality: 'one_to_many', fromLabel: 'Company', toLabel: 'People', ...sys,
  });

  // ── 3. Engagement — the polymorphic core ────────────────────────────────
  const engagement = await CrmSchemaService.createRecordType({
    key: 'engagement', label: 'Engagement', labelPlural: 'Engagements',
    icon: 'handshake', color: '#b5652e', ...sys,
    fields: [
      { key: 'name', label: 'Name', dataType: 'text', isRequired: true, isTitle: true, ...sys },
      { key: 'stage', label: 'Stage', dataType: 'select',
        config: { options: ['Lead', 'Qualified', 'Proposal', 'Scheduled', 'Won', 'Lost'],
          colors: { Lead: '#6c7a72', Won: '#2f7d57', Lost: '#b6493c' } }, ...sys },
      { key: 'value', label: 'Value', dataType: 'currency', ...sys },
      { key: 'scheduled_at', label: 'Scheduled for', dataType: 'datetime', ...sys },
      { key: 'closed_at', label: 'Closed', dataType: 'date', ...sys },
      { key: 'notes', label: 'Notes', dataType: 'long_text', ...sys },
    ],
    seedDefaultView: false, // we create explicit named views below
  });
  if (!engagement.ok || !engagement.id) { console.error('[CrmSystemSeeder] engagement failed:', engagement.error); return; }

  await CrmSchemaService.defineRelationship({
    key: 'engagement_person', fromTypeId: engagement.id, toTypeId: person.id,
    cardinality: 'one_to_many', fromLabel: 'Contact', toLabel: 'Engagements', ...sys,
  });
  await CrmSchemaService.defineRelationship({
    key: 'engagement_company', fromTypeId: engagement.id, toTypeId: company.id,
    cardinality: 'one_to_many', fromLabel: 'Company', toLabel: 'Engagements', ...sys,
  });

  // ── The views: same records, four lenses ─────────────────────────────────
  await CrmSchemaService.createView(engagement.id, {
    name: 'Pipeline', kind: 'kanban', ...sys,
    config: { groupBy: 'stage', colorBy: 'stage', cardFields: ['name', 'value', 'company'],
      filter: { stage: { notIn: ['Won', 'Lost'] } } },
  }); // opportunities
  await CrmSchemaService.createView(engagement.id, {
    name: 'Calendar', kind: 'calendar', ...sys,
    config: { dateField: 'scheduled_at', titleField: 'name', filter: { scheduled_at: { isSet: true } } },
  }); // appointments
  await CrmSchemaService.createView(engagement.id, {
    name: 'Jobs', kind: 'list', ...sys,
    config: { filter: { stage: 'Won' }, sort: [{ field: 'closed_at', dir: 'desc' }],
      fields: ['name', 'company', 'value', 'closed_at'] },
  }); // jobs
  await CrmSchemaService.createView(engagement.id, {
    name: 'All Engagements', kind: 'table', ...sys,
    config: { fields: ['name', 'stage', 'value', 'scheduled_at', 'company', 'contact'] },
  });

  // ── 4. Starter Sales dashboard ────────────────────────────────────────────
  const sales = await CrmSchemaService.createDashboard({ key: 'sales', name: 'Sales', icon: 'chart-line', ...sys });
  if (sales.ok && sales.id) {
    await CrmSchemaService.createWidget(sales.id, {
      recordTypeId: engagement.id, name: 'Pipeline value by stage', kind: 'bar',
      config: { metric: 'sum', field: 'value', groupBy: 'stage', filter: { stage: { notIn: ['Won', 'Lost'] } } },
    });
    await CrmSchemaService.createWidget(sales.id, {
      recordTypeId: engagement.id, name: 'Won this month', kind: 'stat',
      config: { metric: 'sum', field: 'value', filter: { stage: 'Won' }, period: 'this_month' },
    });
    await CrmSchemaService.createWidget(sales.id, {
      recordTypeId: engagement.id, name: 'New engagements', kind: 'line',
      config: { metric: 'count', period: 'last_90d', bucket: 'week' },
    });
    await CrmSchemaService.createWidget(sales.id, {
      recordTypeId: engagement.id, name: 'Win rate', kind: 'stat',
      config: { metric: 'ratio', numerator: { stage: 'Won' }, denominator: { stage: { in: ['Won', 'Lost'] } } },
    });
  }

  console.log('[CrmSystemSeeder] Seeded Company, Person, Engagement + 4 views + Sales dashboard');
}

export { initialize };
