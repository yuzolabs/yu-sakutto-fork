import type { SessionScope } from '@/dom/session';

/**
 * Where X post translation finds its text on x.com.
 *
 * The selectors below were read from x.com's own markup. X has no public contract for them,
 * so each one is named after what it holds and kept in this file only:
 *
 * - Post text, including quoted posts and the part a "Show more" expands, is
 *   `[data-testid="tweetText"]`.
 * - A Community Note is `[data-testid="birdwatch-pivot"]`. Its text is the one direct child
 *   that carries a `dir` attribute; the heading, the translation row and the rating prompt
 *   around it are X's interface.
 * - An Article page is `[data-testid="twitterArticleReadView"]`. Its title is
 *   `[data-testid="twitter-article-title"]` and its body is a read-only rich-text view whose
 *   paragraphs, headings, list items and image captions are each `[data-block="true"]`. The
 *   media sections are `section[data-block]` and are left out, which keeps X's own labels on
 *   embedded media out of the translation.
 * - An article preview in a timeline is the title and summary next to
 *   `[data-testid="article-cover-image"]`.
 *
 * Display names, trends, buttons, polls, other link cards and image descriptions are none of
 * these, so they are never walked.
 */

export const X_BODY_SCOPE_NAME = 'x-body';

export const X_POST_TEXT_SELECTOR = '[data-testid="tweetText"]';
export const X_NOTE_SELECTOR = '[data-testid="birdwatch-pivot"]';
export const X_ARTICLE_READ_VIEW_SELECTOR = '[data-testid="twitterArticleReadView"]';
export const X_ARTICLE_TITLE_SELECTOR = '[data-testid="twitter-article-title"]';
export const X_ARTICLE_BODY_SELECTOR = '[data-testid="twitterArticleRichTextView"]';
export const X_ARTICLE_COVER_SELECTOR = '[data-testid="article-cover-image"]';
/** A post in any list: timeline, conversation, search, profile. */
export const X_POST_SELECTOR = 'article[data-testid="tweet"]';
/** A quoted post inside another post is a link-like card with no `href` of its own. */
const X_QUOTE_CARD_SELECTOR = 'div[role="link"]';

const ARTICLE_BLOCK_SELECTOR = '[data-block="true"]:not(section)';

/** Every element whose own subtree is X text, before nested ones are dropped. */
const CANDIDATE_SELECTOR = [
  X_POST_TEXT_SELECTOR,
  X_NOTE_SELECTOR,
  X_ARTICLE_TITLE_SELECTOR,
  X_ARTICLE_BODY_SELECTOR,
  X_ARTICLE_COVER_SELECTOR,
].join(', ');

/** Elements whose descendants can be X text: the containers `touches` climbs to. */
const CONTAINER_SELECTOR = [
  X_POST_TEXT_SELECTOR,
  X_NOTE_SELECTOR,
  X_ARTICLE_TITLE_SELECTOR,
  X_ARTICLE_BODY_SELECTOR,
].join(', ');

export type XBodyKind = 'post' | 'note' | 'article' | 'article-preview';

/** The text of a Community Note: the direct child of the note that X marks with `dir`. */
export function noteTextElement(note: Element): Element | null {
  for (const child of note.children) {
    if (child.localName === 'div' && child.hasAttribute('dir')) return child;
  }
  return null;
}

/** The title and summary block that sits next to an article preview's cover image. */
export function articlePreviewTextElement(cover: Element): Element | null {
  const next = cover.nextElementSibling;
  if (!next || (next.textContent ?? '').trim().length === 0) return null;
  return next;
}

function pushRoots(found: Element, out: Element[]): void {
  if (found.matches(X_POST_TEXT_SELECTOR) || found.matches(X_ARTICLE_TITLE_SELECTOR)) {
    out.push(found);
    return;
  }
  if (found.matches(X_NOTE_SELECTOR)) {
    const text = noteTextElement(found);
    if (text) out.push(text);
    return;
  }
  if (found.matches(X_ARTICLE_BODY_SELECTOR)) {
    out.push(...found.querySelectorAll(ARTICLE_BLOCK_SELECTOR));
    return;
  }
  if (found.matches(X_ARTICLE_COVER_SELECTOR)) {
    const text = articlePreviewTextElement(found);
    if (text) out.push(text);
  }
}

/**
 * The X text roots inside one document or shadow root, in document order, outermost only.
 * A post quoted inside an Article, or a block nested in another block, is reached through
 * its outer root and is not returned twice.
 */
export function xBodyRoots(container: ParentNode): Element[] {
  const roots: Element[] = [];
  for (const found of container.querySelectorAll(CANDIDATE_SELECTOR)) pushRoots(found, roots);
  roots.sort((a, b) => {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  const outermost: Element[] = [];
  let last: Element | null = null;
  for (const root of roots) {
    // Document order puts an ancestor right before its descendants, so the last root kept
    // is the only one that can contain this one.
    if (last && (last === root || last.contains(root))) continue;
    outermost.push(root);
    last = root;
  }
  return outermost;
}

/**
 * True when a mutation on this node can change X text: it is inside a root, is one, holds
 * one, or sits next to an article preview's cover image.
 */
export function touchesXBody(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  if (element.closest(CONTAINER_SELECTOR)) return true;
  if (element.querySelector(CANDIDATE_SELECTOR)) return true;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.previousElementSibling?.matches(X_ARTICLE_COVER_SELECTOR)) return true;
  }
  return false;
}

export function xBodyScope(): SessionScope {
  return {
    name: X_BODY_SCOPE_NAME,
    roots: (container) => xBodyRoots(container),
    touches: (node) => touchesXBody(node),
  };
}

const STATUS_PATH = /\/status\/(\d+)/u;
const ARTICLE_PATH = /\/article\/(\d+)/u;

function statusIdFromHref(href: string | null): string | null {
  if (!href) return null;
  return STATUS_PATH.exec(href)?.[1] ?? null;
}

/**
 * The status ID of the post that owns `element`, from the permalink X puts around the post's
 * timestamp. A quoted post's card has no permalink of its own, and borrowing the outer post's
 * ID would treat two posts as one, so an element inside a quote card gets no ID.
 */
export function statusIdFor(element: Element): string | null {
  const post = element.closest(X_POST_SELECTOR);
  if (!post) return null;
  const quote = element.closest(X_QUOTE_CARD_SELECTOR);
  if (quote && post.contains(quote) && !quote.matches(X_NOTE_SELECTOR)) {
    for (const link of quote.querySelectorAll('a[href*="/status/"]')) {
      if (link.querySelector('time')) return statusIdFromHref(link.getAttribute('href'));
    }
    return null;
  }
  for (const link of post.querySelectorAll('a[href*="/status/"]')) {
    if (!link.querySelector('time')) continue;
    const card = link.closest(X_QUOTE_CARD_SELECTOR);
    if (card && post.contains(card) && !card.matches(X_NOTE_SELECTOR)) continue;
    return statusIdFromHref(link.getAttribute('href'));
  }
  return null;
}

/** The ID of the Article on screen, from its address or its caption anchors. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export function articleIdFor(readView: Element, pageUrl: string): string | null {
  const path = pathnameOf(pageUrl);
  const fromArticle = ARTICLE_PATH.exec(path)?.[1];
  if (fromArticle) return fromArticle;
  const fromStatus = STATUS_PATH.exec(path)?.[1];
  if (fromStatus) return fromStatus;
  const caption = readView.querySelector('[id^="caption-"]')?.id.slice('caption-'.length);
  return caption && /^\d+$/u.test(caption) ? caption : null;
}
