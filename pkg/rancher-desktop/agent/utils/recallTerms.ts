/**
 * Query-term extraction for the SQL recall fast path.
 *
 * Recall used to hand the conversation to a blocking LLM agent per domain
 * (~45s each). The SQL path instead scores rows by which distinctive terms
 * of the current turn they contain, weighted by inverse document frequency
 * (see IdentityObservationsModel.recallRelevant). This module turns recent
 * user text into those terms: lowercase words of 4+ chars, minus stopwords
 * and generic conversational verbs, most recent message first.
 */

const STOPWORDS = new Set(`
the and for with that this from have what your you are was were will would could should about into they them their there then
than just like also some more most very much make made does done did can not but all any our out its get got want wants wanted
need needs please thanks thank okay yes now new use using used here when where which while who whom why how been being able
still only even over under after before again each every other same such own too via per may might must shall let lets ill
dont cant isnt really sure know think going continue pursuing goal goals review system good success looking ways trying within
improve ready work working works thing things stuff help start started starting look looked keep take took give gave put find
found show tell told said says call called time times today yesterday tomorrow week day days lot lots little big small great
better best right wrong fine gone come came into onto upon well back down doing having maybe yeah yea hey okay alright
`.split(/\s+/).filter(Boolean));

/** Tagged blocks injected by the harness (turn_context, recalled context…) are not the user's words. */
const TAGGED_BLOCK_RE = /<([a-z_][a-z0-9_-]*)>[\s\S]*?<\/\1>/gi;

export function extractRecallTerms(texts: string[], maxTerms = 24): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    const clean = String(text ?? '')
      .replace(TAGGED_BLOCK_RE, ' ')
      .replace(/https?:\/\/\S+/g, ' ');

    for (const raw of clean.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []) {
      const word = raw.toLowerCase().replace(/[._-]+$/, '').replace(/'s$/, '');

      if (word.length < 4 || STOPWORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      terms.push(word);
      if (terms.length >= maxTerms) return terms;
    }
  }

  return terms;
}

/** Escape LIKE wildcards so a term is matched literally. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, m => `\\${ m }`);
}
