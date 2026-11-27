export type VisibilityBand = 'visible' | 'near' | 'far';

export type ContentKind = 'prose' | 'chrome';

const PROSE_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figcaption',
  'dd',
  'dt',
  'li',
]);

const CHROME_SELECTOR = [
  'nav',
  'header',
  'footer',
  'aside',
  'button',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="button"]',
  '[role="menu"]',
].join(', ');

const METADATA_SELECTOR = [
  '.hatnote',
  '.shortdescription',
  '.coordinates',
  '#coordinates',
  '.infobox',
  '.navbox',
  '.vertical-navbox',
  '.sidebar',
  '.sistersitebox',
  '.metadata',
  '.reflist',
  '.mw-references-wrap',
  'ol.references',
  '#catlinks',
  '.mw-authority-control',
  '.side-box',
].join(', ');

/**
 * Navigation, sidebars and controls wait behind the article. A paragraph inside
 * `<main>` or `<article>` stays prose even when the page header is chrome.
 */
export function isChromeBlock(block: Element): boolean {
  const host = block.closest(CHROME_SELECTOR);
  if (!host) return false;
  const main = block.closest('main, article, [role="main"]');
  if (main && !main.contains(host)) return false;
  // A `<header>` inside the article is the article's own title block, and an `<h1>` is the
  // page title wherever the site put it. Treating either as navigation sent the headline
  // to the back of the queue, so it stayed in English after the body was translated. The
  // date, category and tag labels beside the headline still wait: ahead of the body they
  // held the first paragraph back by a whole packed request on the CPU.
  if (host.localName === 'header') {
    if (block.localName === 'h1') return false;
    if (main !== null && (HEADING.test(block.localName) || isParagraphLength(block))) return false;
  }
  return true;
}

/** `h1`–`h6` by local name, in either case: an XML page may spell the tag `<H1>`. */
const HEADING = /^h[1-6]$/iu;
/** The length at which `contentKind` already reads an untagged block as prose. */
const PARAGRAPH_CHARS = 80;

function isParagraphLength(block: Element): boolean {
  return (block.textContent ?? '').trim().length >= PARAGRAPH_CHARS;
}

/** Hatnotes, coordinates, infoboxes and reference lists wait behind the article body. */
export function isMetadataBlock(block: Element): boolean {
  return block.closest(METADATA_SELECTOR) !== null;
}

/**
 * `prose` for text the reader came to read, `chrome` for the navigation, controls and
 * metadata that wait behind it.
 *
 * A block found inside a scope root is prose whatever its tag or length. The scope has
 * already chosen that root as the text to translate, and the length rule exists to hold back
 * the labels of a page's interface, not to sort one chosen paragraph behind another. X
 * Articles show why that matters: their reader is a Draft.js view that renders every
 * paragraph as a `div`, so under the length rule each short paragraph and every heading
 * waited behind every long paragraph further down the page, and the opening of the article
 * was translated last.
 */
export function contentKind(block: Element, scopeRoot?: Element): ContentKind {
  if (scopeRoot !== undefined) return 'prose';
  if (isChromeBlock(block) || isMetadataBlock(block)) return 'chrome';
  const tag = block.tagName.toLowerCase();
  if (PROSE_TAGS.has(tag)) return 'prose';
  const length = (block.textContent ?? '').trim().length;
  if (length >= PARAGRAPH_CHARS && (tag === 'div' || tag === 'section' || tag === 'td')) {
    return 'prose';
  }
  return 'chrome';
}

/**
 * True when a block is a heading: the element itself is `h1`–`h6`, or, inside a scope, so
 * is one of its ancestors up to the scope root.
 *
 * The walker yields the element that holds the text, which is not always the heading element.
 * In Draft.js, the editor behind X Articles, the text of a heading sits in a `div` under the
 * `h1`, and that `div` is the block. Read by its tag alone such a heading was not one: it was
 * packed into a request with the paragraphs around it instead of going alone like every other
 * heading. The walk stops at the scope root, because what surrounds the chosen text belongs
 * to the page.
 */
export function isHeadingBlock(block: Element, scopeRoot?: Element): boolean {
  if (scopeRoot === undefined) return HEADING.test(block.localName);
  for (let node: Element | null = block; node; node = node.parentElement) {
    if (HEADING.test(node.localName)) return true;
    if (node === scopeRoot) return false;
  }
  return false;
}

export function bandForRect(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'width' | 'height'>,
  viewportHeight: number,
): VisibilityBand {
  if (rect.width === 0 && rect.height === 0) return 'far';
  const height = viewportHeight > 0 ? viewportHeight : 800;
  if (rect.bottom > 0 && rect.top < height) return 'visible';
  if (rect.bottom > -height && rect.top < height * 2) return 'near';
  return 'far';
}

/**
 * Lower values run first. Selection is 0. Article prose in every band stays
 * ahead of navigation, infoboxes and reference lists, so a tall Wikipedia
 * sidebar cannot take the model before the next paragraph.
 */
export function translationPriority(
  band: VisibilityBand | 'selection',
  index: number,
  kind: ContentKind | 'selection',
): number {
  if (band === 'selection' || kind === 'selection') return 0;

  const bandRank = band === 'visible' ? 0 : band === 'near' ? 1 : 2;
  const kindBase = kind === 'prose' ? 10 : 50;
  const order = Math.min(Math.max(index, 0), 2000) * 0.004;
  return Math.max(-100, Math.min(100, Number((kindBase + bandRank * 12 + order).toFixed(2))));
}

/**
 * How many viewport heights ahead the page asks PLaMo to translate. This is prefetch for
 * the model itself: text that is about to scroll into view is queued before it is visible,
 * so scrolling finds a finished translation instead of waiting for a cold request.
 */
export function lookaheadScreens(
  tier: 'g' | 'c8' | 'c4' | 'c1' | null,
  pace: 'fast' | 'quality' = 'quality',
  engineSource?: 'in-browser' | 'local-server',
): number {
  const base =
    engineSource === 'local-server'
      ? 2
      : tier === 'g'
        ? 2
        : tier === 'c4' || tier === 'c1'
          ? 0.5
          : 1;
  return pace === 'fast' ? base + 1 : base;
}

/**
 * Page requests kept in flight on the CPU tiers: one for the model's single slot, plus one waiting in the
 * engine's own queue. Without the extra request the model sat idle for the whole round trip
 * between one request finishing and the page sending the next. The waiting request has not
 * reached the model, so it can still be cancelled or overtaken by a selection.
 */
export const TRANSLATION_CONCURRENCY = 2;
/** Enough requests in flight on the GPU tier to fill a wave and have the next one waiting. */
export const GPU_TRANSLATION_CONCURRENCY = 32;
/**
 * Page requests kept in flight toward a local HTTP server. The server itself is limited by
 * `localServerParallel`; the page sends several extra so a finished slot is never idle
 * waiting on the next round trip. Waves are a WebGPU concern and are not used here.
 */
export const LOCAL_SERVER_TRANSLATION_CONCURRENCY = 16;

export function localServerPageConcurrency(parallel: number): number {
  return Math.min(GPU_TRANSLATION_CONCURRENCY, Math.max(8, Math.round(parallel) * 4));
}

export function translationConcurrencyFor(
  tier: 'g' | 'c8' | 'c4' | 'c1' | null,
  engineSource: 'in-browser' | 'local-server' | undefined,
  parallel?: number,
): number {
  if (engineSource === 'local-server') {
    return parallel === undefined
      ? LOCAL_SERVER_TRANSLATION_CONCURRENCY
      : localServerPageConcurrency(parallel);
  }
  return tier === 'g' ? GPU_TRANSLATION_CONCURRENCY : TRANSLATION_CONCURRENCY;
}
