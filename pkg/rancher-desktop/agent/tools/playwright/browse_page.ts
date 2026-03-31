import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';
import { wrapWithBlockingWarning } from './detect_blocking';
import { extractReadableContent } from './readability-extract';

/**
 * Browse Page Tool — combines reading, scrolling, searching, and chunking.
 *
 * Actions:
 *   read          — returns reader-mode content (Readability-enhanced)
 *   scroll_down   — scrolls down one viewport and returns only NEW content
 *   scroll_up     — scrolls up one viewport and returns only NEW content
 *   scroll_to_top — scrolls to the top of the page
 *   search        — searches for text with surrounding context + highlights in browser
 *   chunks        — returns a table of contents with chunk IDs
 *   chunk         — returns a specific content chunk by ID
 */

/* ------------------------------------------------------------------ */
/*  Content cache for diffing on revisits                              */
/* ------------------------------------------------------------------ */

interface CachedPage {
  url:       string;
  content:   string;
  chunks:    ContentChunk[];
  fetchedAt: number;
}

interface ContentChunk {
  id:      number;
  heading: string;
  level:   number;
  content: string;
  chars:   number;
}

const PAGE_CACHE = new Map<string, CachedPage>();
const MAX_CACHE_ENTRIES = 30;

function cacheKey(assetId: string, url: string): string {
  return `${ assetId }:${ url }`;
}

function evictOldest(): void {
  if (PAGE_CACHE.size <= MAX_CACHE_ENTRIES) return;
  let oldestKey = '';
  let oldestTime = Infinity;
  for (const [key, entry] of PAGE_CACHE) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) PAGE_CACHE.delete(oldestKey);
}

/* ------------------------------------------------------------------ */
/*  Semantic chunking                                                  */
/* ------------------------------------------------------------------ */

function buildChunks(content: string): ContentChunk[] {
  const lines = content.split('\n');
  const chunks: ContentChunk[] = [];
  let currentHeading = '(Introduction)';
  let currentLevel = 0;
  let currentLines: string[] = [];
  let chunkId = 0;

  function flushChunk(): void {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      chunks.push({
        id:      chunkId++,
        heading: currentHeading,
        level:   currentLevel,
        content: text,
        chars:   text.length,
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushChunk();
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flushChunk();
  return chunks;
}

/* ------------------------------------------------------------------ */
/*  Content diffing                                                    */
/* ------------------------------------------------------------------ */

function diffContent(oldContent: string, newContent: string): string | null {
  if (oldContent === newContent) return null;

  const oldParagraphs = new Set(oldContent.split('\n\n').map(p => p.trim()).filter(Boolean));
  const newParagraphs = newContent.split('\n\n').map(p => p.trim()).filter(Boolean);

  const added: string[] = [];
  const kept = { count: 0 };

  for (const p of newParagraphs) {
    if (!oldParagraphs.has(p)) {
      added.push(p);
    } else {
      kept.count++;
    }
  }

  // Find removed paragraphs
  const newSet = new Set(newParagraphs);
  const removed = [...oldParagraphs].filter(p => !newSet.has(p));

  if (added.length === 0 && removed.length === 0) return null;

  const parts: string[] = [];
  parts.push(`Page changed: ${ added.length } section(s) added, ${ removed.length } removed, ${ kept.count } unchanged.`);

  if (added.length > 0) {
    parts.push('\n**New content:**');
    parts.push(added.join('\n\n').slice(0, 4000));
  }

  if (removed.length > 0) {
    parts.push(`\n**Removed:** ${ removed.length } section(s)`);
  }

  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Tool class                                                         */
/* ------------------------------------------------------------------ */

export class BrowsePageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const action = (input.action || 'read').toLowerCase();
    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      switch (action) {
        case 'read':
          return await this.handleRead(result.bridge, result.assetId);
        case 'scroll_down':
          return await this.handleScroll(result.bridge, result.assetId, 'down');
        case 'scroll_up':
          return await this.handleScroll(result.bridge, result.assetId, 'up');
        case 'scroll_to_top':
          return await this.handleScrollToTop(result.bridge, result.assetId);
        case 'search':
          return await this.handleSearch(result.bridge, result.assetId, input.query || '');
        case 'chunks':
          return await this.handleChunksList(result.bridge, result.assetId);
        case 'chunk':
          return await this.handleChunkRead(result.bridge, result.assetId, input.chunk_id);
        default:
          return {
            successBoolean: false,
            responseString: `Unknown action "${ action }". Valid: read, scroll_down, scroll_up, scroll_to_top, search, chunks, chunk`,
          };
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error in browse_page (${ action }): ${ (error as Error).message }`,
      };
    }
  }

  /* ── read: Readability-enhanced extraction with diffing ── */

  private async handleRead(bridge: any, assetId: string): Promise<ToolResponse> {
    const title = await bridge.getPageTitle();
    const url = await bridge.getPageUrl();
    const scroll = await bridge.getScrollInfo();

    // Try Readability extraction (main process, high quality)
    let contentText = '';
    let extractedTitle = title;
    try {
      const html = await bridge.getPageHtml();
      if (html && html.length > 200) {
        const extracted = await extractReadableContent({ html, url, extractMode: 'markdown' });
        if (extracted && extracted.text.trim().length > 100) {
          contentText = extracted.text;
          if (extracted.title) extractedTitle = extracted.title;
        }
      }
    } catch {
      // Readability failed — fall through to guest-side extraction
    }

    // Fallback to guest-side reader content
    if (!contentText) {
      const guestContent = await bridge.getReaderContent();
      if (guestContent?.content) {
        contentText = guestContent.content;
      }
    }

    if (!contentText.trim()) {
      return {
        successBoolean: true,
        responseString: `[${ assetId }] Page "${ title }" (${ url }) has no readable content.`,
      };
    }

    // Check for diff against cached version
    const key = cacheKey(assetId, url);
    const cached = PAGE_CACHE.get(key);
    let diffNote = '';
    if (cached) {
      const diff = diffContent(cached.content, contentText);
      if (diff) {
        diffNote = `\n\n---\n**Changes since last read:**\n${ diff }`;
      } else {
        diffNote = '\n\n---\n*Page content unchanged since last read.*';
      }
    }

    // Cache the new content
    const chunks = buildChunks(contentText);
    PAGE_CACHE.set(key, { url, content: contentText, chunks, fetchedAt: Date.now() });
    evictOldest();

    // Build response
    const scrollNote = scroll.moreBelow
      ? `\nScroll: ${ scroll.percent }% — more content below. Use scroll_down to continue.`
      : `\nScroll: ${ scroll.percent }% — at bottom of page.`;

    const chunkNote = chunks.length > 3
      ? `\nPage has ${ chunks.length } sections. Use browse_page(action: 'chunks') for table of contents.`
      : '';

    const raw = `[asset: ${ assetId }]\n# ${ extractedTitle }\n**URL**: ${ url }\n\n${ contentText }${ diffNote }\n\n---${ scrollNote }${ chunkNote }`;
    const { responseString, detection } = wrapWithBlockingWarning(raw, contentText, url);

    return { successBoolean: !detection.blocked, responseString };
  }

  /* ── scroll_down / scroll_up ── */

  private async handleScroll(bridge: any, assetId: string, direction: string): Promise<ToolResponse> {
    let result: any;
    try {
      result = await bridge.scrollAndCapture(direction);
    } catch {
      result = null;
    }

    // Fallback: if sullaBridge.scrollAndCapture failed, use plain window.scrollBy
    if (!result || (result.noNewContent && !result.scrollInfo?.percent)) {
      try {
        const px = direction === 'up' ? -600 : 600;
        await bridge.execInPage(`window.scrollBy(0, ${ px })`);
        await new Promise(r => setTimeout(r, 300));
        const info = await bridge.getScrollInfo();
        const pct = info?.percent ?? '?';
        const more = info?.moreBelow !== false;
        return {
          successBoolean: true,
          responseString: `[${ assetId }] Scrolled ${ direction }. Scroll: ${ pct }%${ more ? ' — more content below.' : ' — at bottom.' }`,
        };
      } catch {
        return { successBoolean: true, responseString: `[${ assetId }] Scrolled ${ direction }.` };
      }
    }

    const scroll = result.scrollInfo || {};
    const percent = scroll.percent ?? '?';
    const moreBelow = scroll.moreBelow !== false;

    if (result.noNewContent) {
      const note = moreBelow
        ? `Scroll: ${ percent }% — more content below but no new text in this section.`
        : `Scroll: ${ percent }% — at bottom of page.`;
      return { successBoolean: true, responseString: `[${ assetId }] Scrolled ${ direction }. ${ note }` };
    }

    const moreNote = moreBelow
      ? `\n\n---\nScroll: ${ percent }% — more content below.`
      : `\n\n---\nScroll: ${ percent }% — at bottom of page.`;

    return {
      successBoolean: true,
      responseString: `[${ assetId }] Scrolled ${ direction } — new content:\n\n${ result.newContent }${ moreNote }`,
    };
  }

  /* ── scroll_to_top ── */

  private async handleScrollToTop(bridge: any, assetId: string): Promise<ToolResponse> {
    try {
      await bridge.scrollToTop();
    } catch {
      // Fallback
      try { await bridge.execInPage('window.scrollTo(0, 0)'); } catch { /* */ }
    }
    return { successBoolean: true, responseString: `[${ assetId }] Scrolled to top of page.` };
  }

  /* ── search: text search with visual highlighting ── */

  private async handleSearch(bridge: any, assetId: string, query: string): Promise<ToolResponse> {
    if (!query.trim()) {
      return { successBoolean: false, responseString: 'Search query is required.' };
    }

    // Inject visual highlights into the page
    try {
      await bridge.execInPage(`
        (function() {
          // Remove previous highlights
          var old = document.querySelectorAll('.sulla-search-highlight');
          for (var i = 0; i < old.length; i++) {
            var parent = old[i].parentNode;
            parent.replaceChild(document.createTextNode(old[i].textContent), old[i]);
            parent.normalize();
          }
          // Add highlight style if not present
          if (!document.getElementById('sulla-highlight-style')) {
            var style = document.createElement('style');
            style.id = 'sulla-highlight-style';
            style.textContent = '.sulla-search-highlight { background: #ffeb3b; color: #000; padding: 2px 4px; border-radius: 3px; outline: 2px solid #f9a825; }';
            document.head.appendChild(style);
          }
        })()
      `);
    } catch { /* non-critical */ }

    const result = await bridge.searchInPage(query);

    if (result.total === 0) {
      return { successBoolean: true, responseString: `[${ assetId }] No matches found for "${ query }".` };
    }

    // Highlight matches visually in the browser
    try {
      const safeQuery = JSON.stringify(query);
      await bridge.execInPage(`
        (function() {
          var query = ${ safeQuery }.toLowerCase();
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          var node;
          var highlighted = 0;
          while ((node = walker.nextNode()) && highlighted < 20) {
            var idx = node.textContent.toLowerCase().indexOf(query);
            if (idx === -1) continue;
            var range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + query.length);
            var span = document.createElement('span');
            span.className = 'sulla-search-highlight';
            range.surroundContents(span);
            highlighted++;
          }
          // Scroll to first highlight
          var first = document.querySelector('.sulla-search-highlight');
          if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        })()
      `);
    } catch { /* non-critical — search results still returned */ }

    const matchLines = result.matches.map((m: { index: number; context: string }, i: number) =>
      `**Match ${ i + 1 }** (position ${ m.index }):\n${ m.context }`,
    );

    const moreNote = result.total > result.matches.length
      ? `\n\nShowing ${ result.matches.length } of ${ result.total } total matches.`
      : '';

    return {
      successBoolean: true,
      responseString: `[${ assetId }] Found ${ result.total } match(es) for "${ query }" (highlighted in browser):\n\n${ matchLines.join('\n\n') }${ moreNote }`,
    };
  }

  /* ── chunks: table of contents ── */

  private async handleChunksList(bridge: any, assetId: string): Promise<ToolResponse> {
    const url = await bridge.getPageUrl();
    const key = cacheKey(assetId, url);
    let cached = PAGE_CACHE.get(key);

    // If no cache, do a fresh read first
    if (!cached) {
      let contentText = '';
      try {
        const html = await bridge.getPageHtml();
        if (html && html.length > 200) {
          const extracted = await extractReadableContent({ html, url, extractMode: 'markdown' });
          if (extracted?.text) contentText = extracted.text;
        }
      } catch { /* ignore */ }
      if (!contentText) {
        const guestContent = await bridge.getReaderContent();
        contentText = guestContent?.content || '';
      }
      if (!contentText.trim()) {
        return { successBoolean: true, responseString: `[${ assetId }] No content to chunk.` };
      }
      const chunks = buildChunks(contentText);
      cached = { url, content: contentText, chunks, fetchedAt: Date.now() };
      PAGE_CACHE.set(key, cached);
      evictOldest();
    }

    if (cached.chunks.length === 0) {
      return { successBoolean: true, responseString: `[${ assetId }] Page has no sections to list.` };
    }

    const toc = cached.chunks.map(c => {
      const indent = '  '.repeat(Math.max(0, c.level - 1));
      return `${ indent }${ c.id }. ${ c.heading } (${ c.chars } chars)`;
    });

    return {
      successBoolean: true,
      responseString: `[${ assetId }] Table of Contents (${ cached.chunks.length } sections):\n\n${ toc.join('\n') }\n\nUse browse_page(action: 'chunk', chunk_id: <id>) to read a specific section.`,
    };
  }

  /* ── chunk: read specific section ── */

  private async handleChunkRead(bridge: any, assetId: string, chunkId: unknown): Promise<ToolResponse> {
    const id = Number(chunkId);
    if (!Number.isFinite(id)) {
      return { successBoolean: false, responseString: 'chunk_id is required (number). Use chunks action to see available IDs.' };
    }

    const url = await bridge.getPageUrl();
    const key = cacheKey(assetId, url);
    const cached = PAGE_CACHE.get(key);

    if (!cached) {
      return { successBoolean: false, responseString: 'No cached content. Call browse_page(action: "read") or browse_page(action: "chunks") first.' };
    }

    const chunk = cached.chunks.find(c => c.id === id);
    if (!chunk) {
      return {
        successBoolean: false,
        responseString: `Chunk ${ id } not found. Available IDs: ${ cached.chunks.map(c => c.id).join(', ') }`,
      };
    }

    // Navigation hints
    const prevChunk = cached.chunks.find(c => c.id === id - 1);
    const nextChunk = cached.chunks.find(c => c.id === id + 1);
    const nav: string[] = [];
    if (prevChunk) nav.push(`Previous: ${ prevChunk.id } "${ prevChunk.heading }"`);
    if (nextChunk) nav.push(`Next: ${ nextChunk.id } "${ nextChunk.heading }"`);

    return {
      successBoolean: true,
      responseString: `[${ assetId }] Section ${ chunk.id }: ${ chunk.heading }\n\n${ chunk.content }${ nav.length ? '\n\n---\n' + nav.join(' | ') : '' }`,
    };
  }
}
