/**
 * packagePage — reads a use case's optional `manifest.page`, the structured
 * sales page in the approved format (results → headline → story → offer →
 * value stack → what's inside → steps → guarantee → FAQ → desk letter).
 *
 * Every field is optional. Anything missing, empty or the wrong shape is
 * dropped, so the page only renders the components the author filled in.
 * Returns null when nothing usable is there, and the detail view falls back
 * to `description_md`.
 */

export interface PackagePageQuote {
  quote: string;
  name:  string;
  role:  string;
}

export interface PackagePageValueStack {
  items:          { label: string; elsewhere: string }[];
  elsewhereTotal: string;
  price:          string;
  cta:            string;
}

export interface PackagePage {
  results:      string;
  headline:     string;
  subhead:      string;
  storyMd:      string;
  imagine:      string[];
  testimonials: PackagePageQuote[];
  offer:        { title: string; tagline: string; perfectFor: string } | null;
  benefits:     { title: string; note: string }[];
  valueStack:   PackagePageValueStack | null;
  inside:       { icon: string; title: string; text: string }[];
  needs:        string;
  steps:        { title: string; text: string }[];
  guarantee:    { title: string; text: string } | null;
  faq:          { q: string; a: string }[];
  desk:         {
    from:     string;
    place:    string;
    headline: string;
    bodyMd:   string;
    signoff:  string;
    name:     string;
    title:    string;
  } | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Map an array of objects, keeping only entries where `keep` is true. */
function list<T>(value: unknown, map: (o: Record<string, unknown>) => T, keep: (t: T) => boolean): T[] {
  return (Array.isArray(value) ? value : []).map(v => map(obj(v))).filter(keep);
}

function hasAny(o: Record<string, string>): boolean {
  return Object.values(o).some(Boolean);
}

export function toPackagePage(manifest: Record<string, unknown>): PackagePage | null {
  const raw = obj(manifest.page ?? obj(manifest.spec).page);
  if (!Object.keys(raw).length) return null;

  const offerIn = obj(raw.offer);
  const offer = { title: str(offerIn.title), tagline: str(offerIn.tagline), perfectFor: str(offerIn.perfect_for) };

  const stackIn = obj(raw.value_stack);
  const stackItems = list(stackIn.items, o => ({ label: str(o.label), elsewhere: str(o.elsewhere) }), i => !!i.label);
  const valueStack: PackagePageValueStack = {
    items:          stackItems,
    elsewhereTotal: str(stackIn.elsewhere_total),
    price:          str(stackIn.price),
    cta:            str(stackIn.cta),
  };

  const guaranteeIn = obj(raw.guarantee);
  const guarantee = { title: str(guaranteeIn.title), text: str(guaranteeIn.text) };

  const deskIn = obj(raw.desk);
  const desk = {
    from:     str(deskIn.from),
    place:    str(deskIn.place),
    headline: str(deskIn.headline),
    bodyMd:   str(deskIn.body_md),
    signoff:  str(deskIn.signoff),
    name:     str(deskIn.name),
    title:    str(deskIn.title),
  };

  const page: PackagePage = {
    results:      str(raw.results),
    headline:     str(raw.headline),
    subhead:      str(raw.subhead),
    storyMd:      str(raw.story_md),
    imagine:      (Array.isArray(raw.imagine) ? raw.imagine : []).map(str).filter(Boolean),
    testimonials: list(raw.testimonials, o => ({ quote: str(o.quote), name: str(o.name), role: str(o.role) }), t => !!t.quote),
    offer:        hasAny(offer) ? offer : null,
    benefits:     list(raw.benefits, o => ({ title: str(o.title), note: str(o.note) }), b => !!b.title),
    valueStack:   stackItems.length || valueStack.price ? valueStack : null,
    inside:       list(raw.inside, o => ({ icon: str(o.icon), title: str(o.title), text: str(o.text) }), t => !!(t.title || t.text)),
    needs:        str(raw.needs),
    steps:        list(raw.steps, o => ({ title: str(o.title), text: str(o.text) }), s => !!(s.title || s.text)),
    guarantee:    guarantee.title || guarantee.text ? guarantee : null,
    faq:          list(raw.faq, o => ({ q: str(o.q), a: str(o.a) }), f => !!(f.q && f.a)),
    desk:         desk.headline || desk.bodyMd ? desk : null,
  };

  const filled = page.results || page.headline || page.storyMd || page.imagine.length || page.testimonials.length ||
    page.offer || page.benefits.length || page.valueStack || page.inside.length || page.steps.length ||
    page.guarantee || page.faq.length || page.desk;

  return filled ? page : null;
}
