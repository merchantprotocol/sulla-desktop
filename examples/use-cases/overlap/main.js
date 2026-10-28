// SPDX-License-Identifier: Apache-2.0
function parts(date, timezone) {
  const f = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
  const out = Object.fromEntries(f.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return {date: `${out.year}-${out.month}-${out.day}`, minutes: Number(out.hour) * 60 + Number(out.minute), text: `${out.year}-${out.month}-${out.day} ${out.hour}:${out.minute}`};
}
function handler(inputs) {
  const ps = inputs.participants || [], duration = Number(inputs.duration_minutes), warnings = [], slots = [];
  if (!ps.length) warnings.push('participants must not be empty');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1440) warnings.push('duration_minutes must be between 1 and 1440');
  for (const p of ps) {
    if (!p.timezone || !Array.isArray(p.windows)) warnings.push('Each participant needs an IANA timezone and windows array');
    for (const w of (p.windows || [])) {
      if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(w.start || '') || !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(w.end || '') || w.start >= w.end) warnings.push('Windows must be ordered HH:MM ranges');
    }
  }
  const start = new Date(`${inputs.from}T00:00:00Z`), end = new Date(`${inputs.to}T23:59:59Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) warnings.push('from and to must be an ordered ISO date range');
  if (warnings.length || !ps.length) return {slots, warnings};
  for (let t = start.valueOf(); t <= end.valueOf() && slots.length < 100; t += 30 * 60000) {
    const d = new Date(t);
    if (ps.every(p => (p.windows || []).some(w => { const a = Number(w.start.slice(0,2))*60+Number(w.start.slice(3)); const b = Number(w.end.slice(0,2))*60+Number(w.end.slice(3)); const q = parts(d, p.timezone).minutes; return q >= a && q + duration <= b; }))) {
      slots.push({utc_start: d.toISOString(), local: ps.map(p => ({timezone:p.timezone, start:parts(d,p.timezone).text, end:parts(new Date(t + duration*60000),p.timezone).text}))});
    }
  }
  return {slots, warnings};
}
module.exports = { handler };
