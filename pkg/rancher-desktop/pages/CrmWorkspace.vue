<template>
  <div
    class="text-sm font-sans page-root h-full"
    :class="{ dark: isDark }"
  >
    <div class="flex flex-col h-full">
      <AgentHeader
        :is-dark="isDark"
        :toggle-theme="toggleTheme"
      />

      <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- ── Sidebar: record types nav ── -->
        <aside class="flex flex-col w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-y-auto">
          <div class="px-4 pt-5 pb-3">
            <h2 class="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Record Types
            </h2>
          </div>

          <nav class="flex-1 px-2 pb-4 space-y-0.5">
            <button
              v-for="rt in schema"
              :key="rt.id"
              type="button"
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors"
              :class="selectedTypeKey === rt.key
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'"
              @click="selectType(rt.key)"
            >
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                :style="{ background: rt.color + '22', color: rt.color }"
              >
                <component :is="iconComponent(rt.icon)" class="h-3.5 w-3.5" />
              </span>
              <span class="flex-1 truncate text-sm">{{ rt.label_plural }}</span>
              <span class="text-xs text-slate-400 dark:text-slate-500 tabular-nums">{{ rt.record_count }}</span>
            </button>
          </nav>

          <div class="px-2 py-3 border-t border-slate-200 dark:border-slate-700">
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-700 dark:hover:text-slate-200 transition-colors text-sm"
            >
              <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New type
            </button>
          </div>
        </aside>

        <!-- ── Main content ── -->
        <div class="flex flex-col flex-1 min-w-0 bg-slate-50 dark:bg-slate-950">
          <!-- toolbar -->
          <div class="flex items-center gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
            <div class="flex-1">
              <h1 class="text-base font-semibold text-slate-900 dark:text-white">
                {{ selectedType?.label_plural ?? 'CRM' }}
              </h1>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {{ filteredRecords.length }} record{{ filteredRecords.length === 1 ? '' : 's' }}
              </p>
            </div>

            <!-- search -->
            <div class="relative">
              <svg
                class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                stroke-width="2"
              >
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                v-model="searchQuery"
                type="text"
                :placeholder="`Search ${selectedType?.label_plural ?? 'records'}…`"
                class="h-9 w-64 rounded-lg pl-9 pr-3 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
            </div>

            <button
              type="button"
              class="flex items-center gap-1.5 h-9 px-4 rounded-lg text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 transition-colors"
              @click="openNewRecord"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New {{ selectedType?.label ?? 'Record' }}
            </button>
          </div>

          <!-- schema-driven table -->
          <div class="flex-1 overflow-auto">
            <table class="min-w-full border-separate border-spacing-0">
              <thead class="sticky top-0 z-10">
                <tr>
                  <th
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 first:pl-6 last:pr-6 whitespace-nowrap"
                  >
                    {{ col.label }}
                  </th>
                  <!-- actions column header -->
                  <th class="w-10 px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800" />
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                <tr
                  v-for="record in filteredRecords"
                  :key="record.id"
                  class="group cursor-pointer hover:bg-white dark:hover:bg-slate-900 transition-colors"
                  @click="openRecord(record)"
                >
                  <td
                    v-for="col in visibleColumns"
                    :key="col.key"
                    class="px-4 py-3 text-sm first:pl-6 last:pr-6"
                    :class="col.is_title
                      ? 'font-medium text-slate-900 dark:text-white'
                      : 'text-slate-600 dark:text-slate-400'"
                  >
                    <CrmCellValue :value="record.field_values[col.key]" :data-type="col.data_type" />
                  </td>
                  <td class="w-10 px-3 py-3 text-right">
                    <button
                      type="button"
                      class="invisible group-hover:visible text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded p-0.5 transition-colors"
                      @click.stop="openRecord(record)"
                    >
                      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </td>
                </tr>

                <!-- empty state -->
                <tr v-if="filteredRecords.length === 0">
                  <td
                    :colspan="visibleColumns.length + 1"
                    class="px-6 py-16 text-center"
                  >
                    <div class="mx-auto w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
                      <svg class="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803M10.5 7.5v6m3-3h-6" />
                      </svg>
                    </div>
                    <p class="text-sm font-medium text-slate-600 dark:text-slate-400">No records found</p>
                    <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      {{ searchQuery ? 'Try a different search term' : `Create the first ${selectedType?.label ?? 'record'}` }}
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── Record detail panel ── -->
        <transition
          enter-active-class="transition-all duration-200"
          enter-from-class="translate-x-4 opacity-0"
          enter-to-class="translate-x-0 opacity-100"
          leave-active-class="transition-all duration-150"
          leave-from-class="translate-x-0 opacity-100"
          leave-to-class="translate-x-4 opacity-0"
        >
          <aside
            v-if="openedRecord"
            class="w-80 shrink-0 flex flex-col border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-y-auto"
          >
            <!-- panel header -->
            <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
              <h3 class="text-sm font-semibold text-slate-900 dark:text-white truncate">
                {{ openedRecord.title }}
              </h3>
              <button
                type="button"
                class="ml-2 shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg p-1 transition-colors"
                @click="openedRecord = null"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- schema-driven fields -->
            <div class="flex-1 px-5 py-4 space-y-4">
              <div
                v-for="field in selectedType?.fields ?? []"
                :key="field.id"
                class="space-y-1"
              >
                <label class="block text-xs font-medium text-slate-400 dark:text-slate-500">
                  {{ field.label }}
                  <span v-if="field.is_required" class="text-red-400 ml-0.5">*</span>
                </label>
                <CrmFieldInput
                  :data-type="field.data_type"
                  :value="openedRecord.field_values[field.key]"
                  :read-only="true"
                />
              </div>
            </div>

            <!-- panel footer -->
            <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
              <p class="text-xs text-slate-400 dark:text-slate-500">
                Created {{ formatDate(openedRecord.created_at) }}
              </p>
              <div class="flex gap-2">
                <button type="button" class="flex-1 rounded-lg py-2 text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                  Edit
                </button>
                <button type="button" class="rounded-lg py-2 px-3 text-sm font-medium text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          </aside>
        </transition>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineComponent, h } from 'vue';
import AgentHeader from '@pkg/pages/agent/AgentHeader.vue';
import { useTheme } from '@pkg/composables/useTheme';

const { isDark, toggleTheme } = useTheme();

// ── Types ──────────────────────────────────────────────────────────────────

type DataType = 'text' | 'number' | 'email' | 'phone' | 'url' | 'boolean' | 'date' | 'select';
type IconKey = 'user' | 'building' | 'chart' | 'target';

interface CrmField {
  id: string;
  key: string;
  label: string;
  data_type: DataType;
  is_title: boolean;
  is_required: boolean;
  position: number;
}

interface CrmRecordType {
  id: string;
  key: string;
  label: string;
  label_plural: string;
  icon: IconKey;
  color: string;
  record_count: number;
  fields: CrmField[];
}

interface CrmRecord {
  id: string;
  record_type_key: string;
  title: string;
  field_values: Record<string, string | number | boolean | null>;
  created_at: string;
}

// ── Mock schema (mirrors crm_record_types + crm_fields) ───────────────────

const schema: CrmRecordType[] = [
  {
    id: 'rt_contact', key: 'contact', label: 'Contact', label_plural: 'Contacts',
    icon: 'user', color: '#3b82f6', record_count: 42,
    fields: [
      { id: 'f_cn1', key: 'full_name',  label: 'Full name',  data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_cn2', key: 'email',      label: 'Email',      data_type: 'email',  is_title: false, is_required: true,  position: 1 },
      { id: 'f_cn3', key: 'phone',      label: 'Phone',      data_type: 'phone',  is_title: false, is_required: false, position: 2 },
      { id: 'f_cn4', key: 'company',    label: 'Company',    data_type: 'text',   is_title: false, is_required: false, position: 3 },
      { id: 'f_cn5', key: 'status',     label: 'Status',     data_type: 'select', is_title: false, is_required: false, position: 4 },
    ],
  },
  {
    id: 'rt_company', key: 'company', label: 'Company', label_plural: 'Companies',
    icon: 'building', color: '#8b5cf6', record_count: 18,
    fields: [
      { id: 'f_co1', key: 'name',        label: 'Name',         data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_co2', key: 'domain',      label: 'Domain',       data_type: 'url',    is_title: false, is_required: false, position: 1 },
      { id: 'f_co3', key: 'industry',    label: 'Industry',     data_type: 'select', is_title: false, is_required: false, position: 2 },
      { id: 'f_co4', key: 'employees',   label: 'Employees',    data_type: 'number', is_title: false, is_required: false, position: 3 },
      { id: 'f_co5', key: 'annual_rev',  label: 'Annual rev.',  data_type: 'number', is_title: false, is_required: false, position: 4 },
    ],
  },
  {
    id: 'rt_deal', key: 'deal', label: 'Deal', label_plural: 'Deals',
    icon: 'chart', color: '#10b981', record_count: 9,
    fields: [
      { id: 'f_dl1', key: 'name',       label: 'Deal name',  data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_dl2', key: 'stage',      label: 'Stage',      data_type: 'select', is_title: false, is_required: true,  position: 1 },
      { id: 'f_dl3', key: 'amount',     label: 'Amount',     data_type: 'number', is_title: false, is_required: false, position: 2 },
      { id: 'f_dl4', key: 'close_date', label: 'Close date', data_type: 'date',   is_title: false, is_required: false, position: 3 },
      { id: 'f_dl5', key: 'probability', label: 'Win %',     data_type: 'number', is_title: false, is_required: false, position: 4 },
    ],
  },
  {
    id: 'rt_lead', key: 'lead', label: 'Lead', label_plural: 'Leads',
    icon: 'target', color: '#f59e0b', record_count: 31,
    fields: [
      { id: 'f_ld1', key: 'name',       label: 'Name',       data_type: 'text',   is_title: true,  is_required: true,  position: 0 },
      { id: 'f_ld2', key: 'email',      label: 'Email',      data_type: 'email',  is_title: false, is_required: false, position: 1 },
      { id: 'f_ld3', key: 'source',     label: 'Source',     data_type: 'select', is_title: false, is_required: false, position: 2 },
      { id: 'f_ld4', key: 'score',      label: 'Score',      data_type: 'number', is_title: false, is_required: false, position: 3 },
      { id: 'f_ld5', key: 'converted',  label: 'Converted',  data_type: 'boolean',is_title: false, is_required: false, position: 4 },
    ],
  },
];

// ── Mock records ───────────────────────────────────────────────────────────

const mockRecords: CrmRecord[] = [
  // Contacts
  { id: 'r1', record_type_key: 'contact', title: 'Jordan Mitchell', created_at: '2026-05-12T14:22:00Z',
    field_values: { full_name: 'Jordan Mitchell', email: 'jordan@apexcoaching.com', phone: '+1 555-0142', company: 'Apex Coaching', status: 'Active' } },
  { id: 'r2', record_type_key: 'contact', title: 'Priya Sharma', created_at: '2026-05-28T09:04:00Z',
    field_values: { full_name: 'Priya Sharma', email: 'priya@scalelab.io', phone: '+1 555-0271', company: 'ScaleLab', status: 'Lead' } },
  { id: 'r3', record_type_key: 'contact', title: 'Marcus Tran', created_at: '2026-06-01T11:50:00Z',
    field_values: { full_name: 'Marcus Tran', email: 'marcus@growthforge.co', phone: null, company: 'GrowthForge', status: 'Active' } },
  { id: 'r4', record_type_key: 'contact', title: 'Sara Okonkwo', created_at: '2026-06-10T16:33:00Z',
    field_values: { full_name: 'Sara Okonkwo', email: 'sara@funnelworks.com', phone: '+1 555-0389', company: 'FunnelWorks', status: 'Churned' } },
  // Companies
  { id: 'r5', record_type_key: 'company', title: 'Apex Coaching', created_at: '2026-04-18T08:00:00Z',
    field_values: { name: 'Apex Coaching', domain: 'apexcoaching.com', industry: 'Education', employees: 24, annual_rev: 4200000 } },
  { id: 'r6', record_type_key: 'company', title: 'ScaleLab', created_at: '2026-04-22T10:15:00Z',
    field_values: { name: 'ScaleLab', domain: 'scalelab.io', industry: 'Marketing', employees: 11, annual_rev: 1800000 } },
  { id: 'r7', record_type_key: 'company', title: 'GrowthForge', created_at: '2026-05-05T14:30:00Z',
    field_values: { name: 'GrowthForge', domain: 'growthforge.co', industry: 'Consulting', employees: 7, annual_rev: 920000 } },
  // Deals
  { id: 'r8', record_type_key: 'deal', title: 'Apex Coaching — Q3 Expansion', created_at: '2026-06-02T13:00:00Z',
    field_values: { name: 'Apex Coaching — Q3 Expansion', stage: 'Proposal', amount: 48000, close_date: '2026-07-31', probability: 65 } },
  { id: 'r9', record_type_key: 'deal', title: 'ScaleLab Renewal', created_at: '2026-06-15T09:45:00Z',
    field_values: { name: 'ScaleLab Renewal', stage: 'Negotiation', amount: 24000, close_date: '2026-07-01', probability: 80 } },
  // Leads
  { id: 'r10', record_type_key: 'lead', title: 'Alex Rivera', created_at: '2026-06-20T11:20:00Z',
    field_values: { name: 'Alex Rivera', email: 'alex@creativehq.io', source: 'Webinar', score: 82, converted: false } },
  { id: 'r11', record_type_key: 'lead', title: 'Nina Kowalski', created_at: '2026-06-21T15:10:00Z',
    field_values: { name: 'Nina Kowalski', email: 'nina@marketmind.co', source: 'LinkedIn', score: 91, converted: true } },
  { id: 'r12', record_type_key: 'lead', title: 'David Chen', created_at: '2026-06-22T08:55:00Z',
    field_values: { name: 'David Chen', email: 'dchen@techsprint.dev', source: 'Referral', score: 74, converted: false } },
];

// ── State ──────────────────────────────────────────────────────────────────

const selectedTypeKey = ref<string>(schema[0].key);
const searchQuery = ref('');
const openedRecord = ref<CrmRecord | null>(null);

// ── Computed ───────────────────────────────────────────────────────────────

const selectedType = computed(() =>
  schema.find((rt) => rt.key === selectedTypeKey.value) ?? null,
);

const visibleColumns = computed(() =>
  (selectedType.value?.fields ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .filter((_, i) => i < 5),
);

const filteredRecords = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const recs = mockRecords.filter((r) => r.record_type_key === selectedTypeKey.value);
  if (!q) return recs;
  return recs.filter((r) =>
    r.title.toLowerCase().includes(q) ||
    Object.values(r.field_values).some(
      (v) => v != null && String(v).toLowerCase().includes(q),
    ),
  );
});

// ── Actions ────────────────────────────────────────────────────────────────

function selectType(key: string) {
  selectedTypeKey.value = key;
  searchQuery.value = '';
  openedRecord.value = null;
}

function openRecord(record: CrmRecord) {
  openedRecord.value = record;
}

function openNewRecord() {
  openedRecord.value = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function iconComponent(icon: IconKey) {
  const paths: Record<IconKey, string> = {
    user:     'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
    building: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2zM9 22V12h6v10',
    chart:    'M3 3v18h18M7 16l4-4 4 4 4-4',
    target:   'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
  };
  return defineComponent({
    render() {
      return h('svg', {
        fill: 'none',
        stroke: 'currentColor',
        viewBox: '0 0 24 24',
        'stroke-width': '2',
        class: 'h-3.5 w-3.5',
      }, [h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: paths[icon] })]);
    },
  });
}

// ── Inline sub-components ──────────────────────────────────────────────────

// Renders a read-only field value with type-appropriate formatting
const CrmCellValue = defineComponent({
  props: {
    value: { type: [String, Number, Boolean, null] as unknown as () => string | number | boolean | null, default: null },
    dataType: { type: String as () => DataType, required: true },
  },
  setup(props) {
    return () => {
      if (props.value == null || props.value === '') {
        return h('span', { class: 'text-slate-300 dark:text-slate-600' }, '—');
      }
      if (props.dataType === 'boolean') {
        return h('span', {
          class: props.value
            ? 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
            : 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
        }, props.value ? 'Yes' : 'No');
      }
      if (props.dataType === 'number') {
        return h('span', { class: 'tabular-nums' }, Number(props.value).toLocaleString());
      }
      if (props.dataType === 'select') {
        return h('span', {
          class: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
        }, String(props.value));
      }
      return h('span', { class: 'truncate max-w-[180px] block' }, String(props.value));
    };
  },
});

// Renders a read-only field input with type-appropriate appearance
const CrmFieldInput = defineComponent({
  props: {
    value: { type: [String, Number, Boolean, null] as unknown as () => string | number | boolean | null, default: null },
    dataType: { type: String as () => DataType, required: true },
    readOnly: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      const baseClass = 'w-full rounded-lg px-3 py-2 text-sm border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100';
      const val = props.value;
      if (props.dataType === 'boolean') {
        return h('div', { class: 'flex items-center gap-2 py-1' }, [
          h('div', {
            class: `h-5 w-5 rounded border-2 flex items-center justify-center ${val ? 'bg-sky-500 border-sky-500' : 'border-slate-300 dark:border-slate-600'}`,
          }, val ? h('svg', { class: 'h-3 w-3 text-white', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24', 'stroke-width': '3' },
            [h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M5 13l4 4L19 7' })]) : null),
          h('span', { class: 'text-sm text-slate-700 dark:text-slate-300' }, val ? 'Yes' : 'No'),
        ]);
      }
      return h('input', {
        type: props.dataType === 'number' ? 'number' : props.dataType === 'date' ? 'date' : 'text',
        value: val != null ? String(val) : '',
        readonly: props.readOnly,
        class: baseClass + (props.readOnly ? ' opacity-80 cursor-default' : ''),
      });
    };
  },
});
</script>
