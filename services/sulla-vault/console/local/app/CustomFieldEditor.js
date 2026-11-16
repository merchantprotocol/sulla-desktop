// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Icons } from './VaultFormat.js';

// Custom field rows in the item editor. Types, limits and validators come from
// customFields.js (mirror of vault-crypto customFields.ts), passed in as `rules`.
// To add a type, give it an editor input here (input) and a detail renderer in
// ItemDetailView.customFieldDetail.
export class CustomFieldEditor {
  constructor(dom, state, rules) {
    this.dom = dom;
    this.state = state;
    this.CF = rules;
  }

  typeName(type) { return this.CF.TYPE_LABELS[type] || `Other (${type})`; }

  newFieldId() { return (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')); }

  rows() { return [...this.dom.byId('custom-fields').querySelectorAll('.custom-field-row')]; }

  updateCount() { const count = this.rows().length; this.dom.byId('custom-field-count').textContent = count ? `${count} of ${this.CF.LIMITS.maxFields}` : ''; this.dom.byId('add-custom-field').disabled = count >= this.CF.LIMITS.maxFields; }

  rowValue(row) {
    const input = row.querySelector('.cf-input');
    if (!input) return '';
    return row.dataset.type === 'boolean' ? String(input.checked) : input.value;
  }

  // Builds the value control for a type. Secrets get a masked input plus a reveal button.
  input(row, type, value) {
    const CF = this.CF; const create = tag => this.dom.create(tag);
    const holder = row.querySelector('.cf-value'); holder.replaceChildren();
    const labelText = () => row.querySelector('.cf-label').value.trim() || 'Custom field';
    let input;
    if (type === 'boolean') {
      const toggle = create('label'); toggle.className = 'cf-toggle';
      input = create('input'); input.type = 'checkbox'; input.checked = value === 'true';
      const track = create('i'); track.setAttribute('aria-hidden', 'true');
      const state = create('span'); state.className = 'cf-toggle-text'; state.textContent = input.checked ? 'Yes' : 'No';
      input.addEventListener('change', () => { state.textContent = input.checked ? 'Yes' : 'No'; });
      toggle.append(input, track, state); holder.append(toggle);
    } else if (type === 'multiline') {
      input = create('textarea'); input.value = value; input.rows = 3; holder.append(input);
    } else {
      input = create('input'); input.value = value; input.autocomplete = 'off'; input.spellcheck = false;
      input.type = ({ password: 'password', 'one-time': 'password', url: 'url', email: 'email', date: 'date', phone: 'tel' })[type] || 'text';
      if (type === 'number') input.inputMode = 'decimal';
      if (CF.SECRET_TYPES.includes(type)) input.autocomplete = 'new-password';
      input.placeholder = ({ url: 'https://example.com', email: 'name@example.com', phone: '+1 555 0100', number: '0', 'one-time': 'Base32 secret or otpauth:// URI', password: 'Secret value' })[type] || 'Value';
      holder.append(input);
      if (CF.SECRET_TYPES.includes(type)) {
        const reveal = this.dom.iconButton(Icons.eyePath, 'Reveal value', 'cf-icon');
        reveal.onclick = () => { const shown = input.type === 'password'; input.type = shown ? 'text' : 'password'; reveal.setAttribute('aria-label', shown ? 'Hide value' : 'Reveal value'); reveal.title = reveal.getAttribute('aria-label'); };
        holder.append(reveal);
      }
    }
    input.classList.add('cf-input');
    input.setAttribute('aria-label', `${labelText()} value`);
    input.addEventListener(type === 'boolean' ? 'change' : 'input', () => this.validateRow(row));
    holder.classList.toggle('with-action', CF.SECRET_TYPES.includes(type));
  }

  setRowNote(row, text, kind) { const note = row.querySelector('.cf-note'); note.textContent = text || ''; note.className = `cf-note${kind ? ` ${kind}` : ''}`; }

  // Inline validation with the shared rules. Returns the first problem or null.
  validateRow(row, final = false) {
    const label = row.querySelector('.cf-label').value;
    const others = this.rows().filter(other => other !== row).map(other => other.querySelector('.cf-label').value);
    const labelProblem = label.trim() || final ? this.CF.labelError(label, others) : null;
    const valueProblem = this.CF.valueError(row.dataset.type, this.rowValue(row));
    const problem = labelProblem || (valueProblem ? `Value ${valueProblem}` : null);
    row.classList.toggle('invalid', Boolean(problem));
    row.querySelector('.cf-label').setAttribute('aria-invalid', String(Boolean(labelProblem)));
    row.querySelector('.cf-input')?.setAttribute('aria-invalid', String(Boolean(valueProblem)));
    if (problem) this.setRowNote(row, problem, 'error'); else if (row.querySelector('.cf-note').classList.contains('error')) this.setRowNote(row, '');
    return problem;
  }

  validateAll() { this.rows().forEach(other => this.validateRow(other)); }

  changeType(row, nextType) {
    const previousType = row.dataset.type; const previous = this.rowValue(row);
    let next = previous; let note = '';
    if (nextType === 'boolean') { if (!['true', 'false'].includes(previous)) { next = 'false'; if (previous) note = `Value cleared: it is not valid for ${this.typeName(nextType)}.`; } }
    else if (previousType === 'boolean') next = '';
    else if (previous && this.CF.valueError(nextType, previous)) { next = ''; note = `Value cleared: it is not valid for ${this.typeName(nextType)}.`; }
    row.dataset.type = nextType; this.input(row, nextType, next);
    this.validateRow(row); if (note) this.setRowNote(row, note, 'warn');
  }

  addRow(field = {}) {
    const CF = this.CF; const create = tag => this.dom.create(tag);
    const root = this.dom.byId('custom-fields'); const type = field.type || 'text';
    const row = create('div'); row.className = 'custom-field-row'; row.dataset.fieldId = field.id || this.newFieldId(); row.dataset.type = type;
    if (field.hidden !== undefined) row.dataset.hidden = String(field.hidden);
    const head = create('div'); head.className = 'cf-head';
    const label = create('input'); label.className = 'cf-label'; label.placeholder = 'Label'; label.maxLength = CF.LIMITS.maxLabelLength; label.value = field.label || ''; label.autocomplete = 'off'; label.setAttribute('aria-label', 'Custom field label');
    const select = create('select'); select.className = 'cf-type'; select.setAttribute('aria-label', 'Value type');
    for (const value of CF.isKnownType(type) ? CF.TYPES : [...CF.TYPES, type]) { const option = create('option'); option.value = value; option.textContent = this.typeName(value); select.append(option); }
    select.value = type;
    select.onchange = () => this.changeType(row, select.value);
    const up = this.dom.iconButton('<path d="m6 15 6-6 6 6"/>', 'Move field up', 'cf-icon'); up.onclick = () => { if (row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling); };
    const down = this.dom.iconButton('<path d="m6 9 6 6 6-6"/>', 'Move field down', 'cf-icon'); down.onclick = () => { if (row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row); };
    const remove = this.dom.iconButton('<path d="M6 6l12 12M18 6 6 18"/>', 'Remove custom field', 'cf-icon cf-remove'); remove.onclick = () => { row.remove(); this.updateCount(); this.validateAll(); };
    head.append(label, select, up, down, remove);
    const value = create('div'); value.className = 'cf-value';
    const note = create('p'); note.className = 'cf-note'; note.setAttribute('role', 'status');
    row.append(head, value, note); root.append(row);
    this.input(row, type, typeof field.value === 'string' ? field.value : '');
    label.addEventListener('input', () => { row.querySelector('.cf-input')?.setAttribute('aria-label', `${label.value.trim() || 'Custom field'} value`); this.validateAll(); });
    this.updateCount();
    return label;
  }

  render(fields) { this.dom.byId('custom-fields').replaceChildren(); for (const field of Array.isArray(fields) ? fields.slice(0, this.CF.LIMITS.maxFields) : []) this.addRow(field); this.updateCount(); }

  // Collects editor rows in display order and validates them with the shared rules (fails closed).
  read() {
    const rows = this.rows();
    const problems = rows.map(row => this.validateRow(row, true));
    const first = problems.findIndex(Boolean);
    if (first >= 0) { rows[first].querySelector('.cf-label').focus(); throw new Error(`Custom field ${first + 1}: ${problems[first]}`); }
    const fields = rows.map(row => ({ id: row.dataset.fieldId, label: row.querySelector('.cf-label').value.trim(), type: row.dataset.type, value: this.rowValue(row), ...(row.dataset.hidden ? { hidden: row.dataset.hidden === 'true' } : {}) }));
    const preserved = Array.isArray(this.state.editingItem?.customFields) ? this.state.editingItem.customFields : [];
    const checked = this.CF.validate(fields, { preserved });
    if (!checked.ok) throw new Error(checked.error);
    return checked.fields;
  }

  bind() {
    this.dom.byId('add-custom-field').onclick = () => { if (this.rows().length >= this.CF.LIMITS.maxFields) return this.dom.message(`Custom fields are limited to ${this.CF.LIMITS.maxFields}.`, true); this.addRow().focus(); };
  }
}
