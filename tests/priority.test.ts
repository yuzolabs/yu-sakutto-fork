// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  bandForRect,
  contentKind,
  isHeadingBlock,
  lookaheadScreens,
  translationConcurrencyFor,
  translationPriority,
} from '@/dom/priority';

describe('translation priority', () => {
  it('finishes article prose before navigation and infoboxes', () => {
    const visibleProse = translationPriority('visible', 2000, 'prose');
    const nearProse = translationPriority('near', 0, 'prose');
    const farProse = translationPriority('far', 2000, 'prose');
    const visibleChrome = translationPriority('visible', 0, 'chrome');
    const farChrome = translationPriority('far', 0, 'chrome');

    expect(translationPriority('selection', 0, 'prose')).toBe(0);
    expect(visibleProse).toBeLessThan(nearProse);
    expect(nearProse).toBeLessThan(farProse);
    expect(farProse).toBeLessThan(visibleChrome);
    expect(visibleChrome).toBeLessThan(farChrome);
  });

  it('classifies article text as prose and navigation as chrome', () => {
    document.body.innerHTML = `
      <nav><ul><li><a href="#a">Etymology</a></li></ul></nav>
      <aside><div>Appearance</div></aside>
      <main>
        <h1>Osaka</h1>
        <p>Osaka is a designated city.</p>
      </main>
    `;

    const item = document.querySelector('li');
    const appearance = document.querySelector('aside div');
    const heading = document.querySelector('h1');
    const paragraph = document.querySelector('p');
    if (!item || !appearance || !heading || !paragraph) throw new Error('missing blocks');

    expect(contentKind(item)).toBe('chrome');
    expect(contentKind(appearance)).toBe('chrome');
    expect(contentKind(heading)).toBe('prose');
    expect(contentKind(paragraph)).toBe('prose');
  });

  it('treats an article headline in its own header as prose and the site header as chrome', () => {
    document.body.innerHTML = `
      <header><a href="/">Home</a><div>Sign in to continue reading</div></header>
      <main>
        <article>
          <header><h1>Funding the harbour libraries</h1></header>
          <p>The cooperative is placing part of its surplus into branch libraries.</p>
        </article>
      </main>
    `;

    const site = document.querySelector('body > header div');
    const headline = document.querySelector('h1');
    if (!site || !headline) throw new Error('missing blocks');

    expect(contentKind(site)).toBe('chrome');
    expect(contentKind(headline)).toBe('prose');
  });

  it('keeps the date and category labels of an article header behind the body', () => {
    document.body.innerHTML = `
      <main>
        <article>
          <header>
            <h1>Funding the harbour libraries</h1>
            <p id="dek">The cooperative is placing part of its surplus into a fund for branch libraries.</p>
            <p id="date">Oct 18, 2026</p>
            <p id="category">Announcements</p>
          </header>
          <p>The cooperative is placing part of its surplus into branch libraries.</p>
        </article>
      </main>
    `;

    const block = (selector: string): Element => {
      const found = document.querySelector(selector);
      if (!found) throw new Error(`missing ${selector}`);
      return found;
    };

    expect(contentKind(block('h1'))).toBe('prose');
    expect(contentKind(block('#dek'))).toBe('prose');
    expect(contentKind(block('#date'))).toBe('chrome');
    expect(contentKind(block('#category'))).toBe('chrome');
  });

  it('keeps hatnotes, coordinates and infoboxes behind the lead paragraph', () => {
    document.body.innerHTML = `
      <div class="hatnote">For other uses, see Osaka (disambiguation) and the places that share the name.</div>
      <div id="coordinates">Coordinates: 34°41′38″N 135°30′8″E</div>
      <table class="infobox"><tbody><tr><td>Osaka is the capital of Osaka Prefecture and this cell is long enough to look like a paragraph.</td></tr></tbody></table>
      <p>Osaka is a designated city in the Kansai region.</p>
    `;

    const hatnote = document.querySelector('.hatnote');
    const coordinates = document.querySelector('#coordinates');
    const cell = document.querySelector('td');
    const lead = document.querySelector('p');
    if (!hatnote || !coordinates || !cell || !lead) throw new Error('missing blocks');

    expect(contentKind(hatnote)).toBe('chrome');
    expect(contentKind(coordinates)).toBe('chrome');
    expect(contentKind(cell)).toBe('chrome');
    expect(contentKind(lead)).toBe('prose');
    expect(translationPriority('visible', 40, 'prose')).toBeLessThan(
      translationPriority('visible', 0, 'chrome'),
    );
  });

  it('reads every block inside a scope as prose and finds the heading above its block', () => {
    // X Articles are a Draft.js view. Each paragraph or heading is a `[data-block]` element
    // whose text sits in one `div` inside it, and that `div` is the block the walker yields.
    // Every block is a `div`, so by tag and length alone all three read as interface chrome.
    document.body.innerHTML = `
      <div data-testid="twitterArticleRichTextView">
        <div data-contents="true">
          <h1 class="longform-header-one" data-block="true" data-offset-key="a-0-0">
            <div data-offset-key="a-0-0" class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
              <span data-offset-key="a-0-0"><span data-text="true">Part 1: Colab credits and the CLI</span></span>
            </div>
          </h1>
          <div class="longform-unstyled" data-block="true" data-offset-key="b-0-0">
            <div data-offset-key="b-0-0" class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
              <span data-offset-key="b-0-0"><span data-text="true">The cheapest way to start.</span></span>
            </div>
          </div>
          <h2 class="longform-header-two" data-block="true" data-offset-key="c-0-0">
            <div data-offset-key="c-0-0" class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">
              <span data-offset-key="c-0-0"><span data-text="true">Advanced</span></span>
            </div>
          </h2>
        </div>
      </div>
    `;

    const blocks = [...document.querySelectorAll('.public-DraftStyleDefault-block')];
    const roots = [...document.querySelectorAll('[data-block="true"]')];
    const [heading, paragraph, shortHeading] = blocks;
    const [headingRoot, paragraphRoot, shortHeadingRoot] = roots;
    if (!heading || !paragraph || !shortHeading) throw new Error('missing blocks');

    expect(contentKind(heading)).toBe('chrome');
    expect(contentKind(paragraph)).toBe('chrome');
    expect(contentKind(heading, headingRoot)).toBe('prose');
    expect(contentKind(paragraph, paragraphRoot)).toBe('prose');
    expect(isHeadingBlock(heading)).toBe(false);
    expect(isHeadingBlock(paragraph)).toBe(false);
    expect(isHeadingBlock(heading, headingRoot)).toBe(true);
    expect(isHeadingBlock(paragraph, paragraphRoot)).toBe(false);
    expect(isHeadingBlock(shortHeading, shortHeadingRoot)).toBe(true);

    // On screen, they go ahead of a long paragraph further down the page.
    expect(translationPriority('visible', 4, contentKind(heading, headingRoot))).toBeLessThan(
      translationPriority('far', 40, 'prose'),
    );
  });

  it('reads a heading by its own tag on a whole page and stops at the scope root', () => {
    document.body.innerHTML = `
      <h2>Why it matters</h2>
      <div><span>A plain block on the page.</span></div>
      <h1>
        A page title
        <div data-scope><span>with chosen text inside the title element.</span></div>
      </h1>
      <h3 data-scope><div><span>A heading that is the scope root itself.</span></div></h3>
    `;

    const heading = document.querySelector('h2');
    const plain = document.querySelector('body > div');
    const chosen = document.querySelector('[data-scope]');
    const root = document.querySelector('h3[data-scope]');
    const inside = root?.firstElementChild;
    if (!heading || !plain || !chosen || !root || !inside) throw new Error('missing blocks');

    expect(isHeadingBlock(heading)).toBe(true);
    expect(isHeadingBlock(plain)).toBe(false);
    // An XML page may spell its tags in capitals; the heading is still one.
    const xml = document.implementation.createDocument(null, 'root', null);
    expect(isHeadingBlock(xml.createElement('H2'))).toBe(true);
    expect(isHeadingBlock(xml.createElement('DIV'))).toBe(false);
    // The `h1` around the scope is the page's, so the chosen text is not a heading.
    expect(isHeadingBlock(chosen, chosen)).toBe(false);
    // A heading that is the scope root counts, for itself and for the block inside it.
    expect(isHeadingBlock(root, root)).toBe(true);
    expect(isHeadingBlock(inside, root)).toBe(true);
  });

  it('treats an on-screen box as visible and a distant one as far', () => {
    expect(bandForRect({ top: 10, bottom: 40, width: 100, height: 30 }, 800)).toBe('visible');
    expect(bandForRect({ top: 900, bottom: 940, width: 100, height: 40 }, 800)).toBe('near');
    expect(bandForRect({ top: 4000, bottom: 4040, width: 100, height: 40 }, 800)).toBe('far');
    expect(bandForRect({ top: 0, bottom: 0, width: 0, height: 0 }, 800)).toBe('far');
  });

  it('prefetches more of the page for PLaMo when the look-ahead is widened', () => {
    // The look-ahead is how much of the page is handed to PLaMo before it is on screen.
    // It used to decide how much Chrome drafted; now it is pure model prefetch.
    expect(lookaheadScreens('g', 'quality')).toBe(2);
    expect(lookaheadScreens('c8', 'quality')).toBe(1);
    expect(lookaheadScreens('c4', 'quality')).toBe(0.5);
    expect(lookaheadScreens('c1', 'quality')).toBe(0.5);
    expect(lookaheadScreens('g', 'fast')).toBeGreaterThan(lookaheadScreens('g', 'quality'));
    expect(lookaheadScreens('c8', 'fast')).toBeGreaterThan(lookaheadScreens('c8', 'quality'));
    expect(lookaheadScreens(null, 'fast')).toBeGreaterThan(lookaheadScreens(null, 'quality'));
    expect(lookaheadScreens(null, 'quality', 'local-server')).toBe(2);
    expect(lookaheadScreens('c1', 'quality', 'local-server')).toBe(2);
  });

  it('keeps more page requests in flight toward a local HTTP server than a CPU tier', () => {
    expect(translationConcurrencyFor(null, 'local-server', 4)).toBe(16);
    expect(translationConcurrencyFor('c8', 'local-server', 4)).toBe(16);
    expect(translationConcurrencyFor('c8', 'in-browser')).toBe(2);
    expect(translationConcurrencyFor('g', 'in-browser')).toBe(32);
  });
});
