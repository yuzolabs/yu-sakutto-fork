import {
  X_ARTICLE_COVER_SELECTOR,
  X_ARTICLE_READ_VIEW_SELECTOR,
  X_NOTE_SELECTOR,
  X_POST_SELECTOR,
  X_POST_TEXT_SELECTOR,
  articleIdFor,
  noteTextElement,
  statusIdFor,
  type XBodyKind,
} from './locate';

/**
 * Turning off X's Grok translation means pressing X's own "Show original" control for an
 * item, in this tab only. Nothing here calls X's API or changes the reader's X settings.
 *
 * X gives the control no stable test id, so it is found by its accessible name in the two
 * interface languages this supports, and only where the surrounding markup says which item
 * it belongs to. The same control reads "Show translation" once the original is shown; that
 * label is never matched, so a reader who switches back to X's translation is left alone.
 */
const SHOW_ORIGINAL_LABELS: Readonly<Record<'ja' | 'en', string>> = {
  ja: '原文を表示',
  en: 'Show original',
};

/** The label of X's "Show original" control for X's interface language, or null if unknown. */
export function showOriginalLabel(uiLanguage: string | null | undefined): string | null {
  const tag = (uiLanguage ?? '').trim().toLowerCase();
  if (tag === 'ja' || tag.startsWith('ja-')) return SHOW_ORIGINAL_LABELS.ja;
  if (tag === 'en' || tag.startsWith('en-')) return SHOW_ORIGINAL_LABELS.en;
  return null;
}

export interface ShowOriginalControl {
  /** Unique per item for the life of the tab: `post:<status>`, `note:<status>`, … */
  id: string;
  kind: XBodyKind;
  control: HTMLElement;
}

function isControl(element: Element): element is HTMLElement {
  return (
    'click' in element &&
    (element.localName === 'button' || element.getAttribute('role') === 'button')
  );
}

function controlLabel(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria !== null) return aria.trim();
  return (element.textContent ?? '').trim();
}

/**
 * The item a "Show original" control belongs to, or null when the markup does not say.
 *
 * - Post: the control's row sits right before the post text.
 * - Note: the row's wrapper is a direct child of the note, and the note's text follows it.
 * - Article: the control is inside the Article page and not inside a post embedded in it.
 * - Article preview: the control is in the same card as the preview's cover image.
 */
function ownerOf(control: HTMLElement, pageUrl: string): ShowOriginalControl | null {
  const row = control.parentElement;
  if (!row) return null;

  if (row.nextElementSibling?.matches(X_POST_TEXT_SELECTOR)) {
    const status = statusIdFor(row.nextElementSibling);
    return status ? { id: `post:${status}`, kind: 'post', control } : null;
  }

  const note = control.closest(X_NOTE_SELECTOR);
  if (note) {
    const wrapper = row.parentElement;
    const text = noteTextElement(note);
    if (!wrapper || wrapper.parentElement !== note || !text) return null;
    if (!(wrapper.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
    const status = statusIdFor(note);
    return status ? { id: `note:${status}`, kind: 'note', control } : null;
  }

  const readView = control.closest(X_ARTICLE_READ_VIEW_SELECTOR);
  if (readView && !control.closest(X_POST_SELECTOR)) {
    const article = articleIdFor(readView, pageUrl);
    return article ? { id: `article:${article}`, kind: 'article', control } : null;
  }

  const card = control.closest(X_POST_SELECTOR);
  if (card) {
    for (const cover of card.querySelectorAll(X_ARTICLE_COVER_SELECTOR)) {
      const preview = cover.parentElement;
      if (!preview?.contains(control)) continue;
      const status = statusIdFor(cover);
      return status ? { id: `article-preview:${status}`, kind: 'article-preview', control } : null;
    }
  }
  return null;
}

/** Every "Show original" control on the page that belongs to an identifiable X item. */
export function findShowOriginalControls(
  container: ParentNode,
  label: string,
  pageUrl: string,
): ShowOriginalControl[] {
  const found: ShowOriginalControl[] = [];
  const seen = new Set<Element>();
  const candidates = container.querySelectorAll(
    `button[aria-label=${JSON.stringify(label)}], [role="button"][aria-label=${JSON.stringify(label)}], button:not([aria-label]), [role="button"]:not([aria-label])`,
  );
  for (const candidate of candidates) {
    if (seen.has(candidate) || !isControl(candidate)) continue;
    seen.add(candidate);
    if (controlLabel(candidate) !== label) continue;
    const owner = ownerOf(candidate, pageUrl);
    if (owner) found.push(owner);
  }
  return found;
}

export interface GrokUnlockerOptions {
  /** True while Sakutto can translate what the press reveals; nothing is pressed otherwise. */
  canUnlock: () => boolean;
  /** X's interface language. Defaults to the page's `<html lang>`. */
  uiLanguage?: () => string | null;
  /** Called after a press, for logging and tests. */
  onUnlock?: (control: ShowOriginalControl) => void;
  /** How long to wait for X to finish a burst of DOM changes before looking again. */
  debounceMs?: number;
  /**
   * Whether an item is on screen or about to be. X keeps a few screens of a timeline
   * mounted; only what the reader is about to see is pressed. Defaults to
   * `nearViewport`.
   */
  isNearViewport?: (control: HTMLElement) => boolean;
}

const DEFAULT_DEBOUNCE_MS = 60;
/** How far past the viewport, in viewport heights, an item may be and still be pressed. */
const LOOKAHEAD_SCREENS = 1;

/** True for a laid-out control within one viewport height above or below the screen. */
export function nearViewport(control: HTMLElement): boolean {
  const doc = control.ownerDocument;
  const height = doc.defaultView?.innerHeight || doc.documentElement.clientHeight || 0;
  const rect = control.getBoundingClientRect();
  // A control with no box is hidden or not laid out yet; it is not on screen.
  if (rect.width === 0 && rect.height === 0) return false;
  const margin = height * LOOKAHEAD_SCREENS;
  return rect.bottom >= -margin && rect.top <= height + margin;
}

/**
 * Presses X's "Show original" once per item per tab while X post translation can run.
 *
 * The record of pressed items lives only in this object, for the life of the document. It
 * is never written to the page's storage. X rebuilds a post's elements when it scrolls back
 * or opens the post, so the record is keyed by the item's ID rather than its element; a
 * reload starts a fresh record.
 */
export class GrokUnlocker {
  private readonly pressed = new Set<string>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onScroll = (): void => this.schedule();
  private readonly debounceMs: number;
  private readonly isNearViewport: (control: HTMLElement) => boolean;

  constructor(
    private readonly doc: Document,
    private readonly options: GrokUnlockerOptions,
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.isNearViewport = options.isNearViewport ?? nearViewport;
  }

  get running(): boolean {
    return this.observer !== null;
  }

  /** IDs pressed in this tab so far. */
  pressedIds(): ReadonlySet<string> {
    return this.pressed;
  }

  start(): void {
    if (this.observer) return;
    const root = this.doc.body ?? this.doc.documentElement;
    const View = this.doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    this.observer = new View(() => this.schedule());
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label'],
    });
    this.doc.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.sweep();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener('scroll', this.onScroll, { capture: true });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Looks for controls to press now. Safe to call at any time; it presses each item once. */
  sweep(): void {
    if (!this.observer || !this.options.canUnlock()) return;
    const language = this.options.uiLanguage?.() ?? this.doc.documentElement.lang;
    const label = showOriginalLabel(language);
    if (!label) return;
    const pageUrl = this.doc.defaultView?.location.href ?? '';
    for (const target of findShowOriginalControls(this.doc, label, pageUrl)) {
      if (this.pressed.has(target.id)) continue;
      if (!this.isNearViewport(target.control)) continue;
      this.pressed.add(target.id);
      target.control.click();
      this.options.onUnlock?.(target);
    }
  }

  private schedule(): void {
    if (!this.observer || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweep();
    }, this.debounceMs);
  }
}
