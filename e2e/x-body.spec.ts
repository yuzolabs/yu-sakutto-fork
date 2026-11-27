import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { FakePace } from '../src/dom/fake-engine';
import { loadExtension } from './extension';
import { commandPage, openExtensionShadowRoots, resetExtensionStorage, tabIdForPage } from './page';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');
const X_BODY_HTML = readFileSync(join(FIXTURE_DIR, 'x-body.html'), 'utf8');
const X_ARTICLE_HTML = readFileSync(join(FIXTURE_DIR, 'x-article.html'), 'utf8');
/** What the fake engine puts in front of a Japanese translation. */
const MARK = '§ja§';

/** The Grok-translated post as X first draws it, to add a newly loaded post later. */
const GROK_POST = (() => {
  const start = X_BODY_HTML.indexOf(
    '<article data-testid="tweet" role="article" tabindex="0" id="post-grok">',
  );
  const end = X_BODY_HTML.indexOf('</article>', start) + '</article>'.length;
  return X_BODY_HTML.slice(start, end);
})();

interface ExtensionChrome {
  tabs: { sendMessage(tabId: number, message: unknown): Promise<unknown> };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

interface ViewState {
  active: boolean;
  scope?: string;
  stopped?: boolean;
  pending: number;
}

/**
 * Serves the synthetic timeline for any x.com page and the Article for an Article path.
 * A pace makes the fake engine take a measurable time over each request, so the order the
 * page sends them in can be read while the translation runs.
 */
async function mockX(context: BrowserContext, pace?: FakePace): Promise<void> {
  const article =
    pace === undefined
      ? X_ARTICLE_HTML
      : X_ARTICLE_HTML.replace(
          '<html lang="ja">',
          `<html lang="ja" data-bench-pace='${JSON.stringify(pace)}'>`,
        );
  await context.route('https://x.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: path.includes('/article/') ? article : X_BODY_HTML,
    });
  });
}

/**
 * Notes each block as the page sends it to the model. A block is marked
 * `data-sakutto-pending` when its request starts, so the order of those marks is the order
 * of the requests, whatever the engine does afterwards.
 */
async function recordRequestStarts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const starts: string[] = [];
    (window as unknown as { requestStarts: string[] }).requestStarts = starts;
    const seen = new WeakSet<Element>();
    const label = (element: Element): string =>
      (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (!(target instanceof Element) || seen.has(target)) continue;
        if (!target.hasAttribute('data-sakutto-pending')) continue;
        seen.add(target);
        starts.push(label(target));
      }
    }).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-sakutto-pending'],
    });
  });
}

function requestStarts(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { requestStarts: string[] }).requestStarts ?? [],
  );
}

async function pageState(worker: Worker, page: Page): Promise<ViewState> {
  const tabId = await tabIdForPage(worker, page);
  return worker.evaluate(async (tabId) => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    return (await chrome.tabs.sendMessage(tabId, { type: 'page:state' })) as ViewState;
  }, tabId);
}

async function setSiteRules(worker: Worker, rules: Record<string, unknown>): Promise<void> {
  await worker.evaluate(async (rules) => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    await chrome.storage.local.set({ siteRules: rules });
  }, rules);
}

async function setXBodySetting(worker: Worker, on: boolean): Promise<void> {
  await worker.evaluate(async (on) => {
    const chrome = (globalThis as unknown as { chrome: ExtensionChrome }).chrome;
    const stored = await chrome.storage.local.get('settings');
    const settings = (stored.settings ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({ settings: { ...settings, translateXBody: on } });
  }, on);
}

async function presses(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () =>
      JSON.parse(document.documentElement.dataset.fixturePresses ?? '{}') as Record<string, number>,
  );
}

function postText(page: Page, selector: string) {
  return page.locator(`${selector} [data-testid="tweetText"]`).first();
}

const ALL_PRESSES = { 'post-grok:post': 1, 'post-note:post': 1, 'post-note:note': 1 };

/**
 * Scrolls the post with a Community Note into view. Grok translations are only turned off
 * near the screen, and this post sits below the first screen of the timeline.
 */
async function revealNotePost(page: Page): Promise<void> {
  await page.locator('#post-note').scrollIntoViewIfNeeded();
  await expect.poll(async () => presses(page)).toEqual(ALL_PRESSES);
}

/** Waits until every visible X text the fixture holds has settled. */
async function waitTranslated(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-sakutto-state', /translated|partial/);
}

async function openTimeline(
  context: BrowserContext,
  worker: Worker,
  options: { translateXBody: boolean },
): Promise<Page> {
  await mockX(context);
  await resetExtensionStorage(worker, { targetLanguage: 'ja', ...options });
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  return page;
}

test.describe('X post translation', () => {
  test('turns off Grok translations and translates only foreign X text', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await openTimeline(extension.context, extension.worker, {
        translateXBody: true,
      });
      // The background injects the content script into the x.com tab on its own.
      await waitTranslated(page);
      // Only the post on the first screen had its Grok translation turned off so far.
      expect(await presses(page)).toEqual({ 'post-grok:post': 1 });

      // Scrolling further turns off the next ones, once per item, and they are translated.
      await revealNotePost(page);
      await expect(postText(page, '#post-grok')).toContainText(MARK);
      await expect(postText(page, '#post-grok')).toContainText(
        'The original post is written in English.',
      );
      await expect(postText(page, '#post-note')).toContainText(MARK);
      await expect(page.locator('[data-testid="birdwatch-pivot"] > div[dir]')).toContainText(MARK);
      // A foreign post X never translated, a quoted post and an article preview.
      await expect(postText(page, '#post-untranslated')).toContainText(MARK);
      await expect(postText(page, '[data-fixture="quote-foreign"]')).toContainText(MARK);
      await expect(
        page.locator('#post-article-preview [data-testid="article-cover-image"] + div'),
      ).toContainText(MARK);

      // Text already in the target language stays as it is, Grok's own included.
      await expect(postText(page, '#post-japanese')).not.toContainText('§');
      await expect(postText(page, '[data-fixture="quote-grok"]')).not.toContainText('§');
      // Names, trends, polls, link cards and X's own labels are not X text.
      for (const selector of [
        '#post-grok [data-testid="User-Name"]',
        '[data-testid="trend"]',
        '[data-testid="cardPoll"]',
        '[data-testid="card.wrapper"]',
        'nav[aria-label="Primary"]',
      ]) {
        await expect(page.locator(selector).first()).not.toContainText('§');
      }
      // The page language belongs to X; a scoped run leaves it alone.
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');

      const state = await pageState(extension.worker, page);
      expect(state.scope).toBe('x-body');
      expect(state.active).toBe(true);
      // The bar says it is X post translation, not a whole-page translation.
      await expect(page.locator('sakutto-bar')).toHaveAttribute(
        'aria-label',
        'X本文翻訳の進み具合',
      );
    } finally {
      await extension.close();
    }
  });

  test('presses once per item and stops and resumes from the page command', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await openTimeline(extension.context, extension.worker, {
        translateXBody: true,
      });
      await waitTranslated(page);
      await revealNotePost(page);
      await expect(postText(page, '#post-note')).toContainText(MARK);

      // The reader switches one post back to Grok's translation; Sakutto leaves it.
      await page.locator('#post-grok button[aria-label="翻訳を表示"]').click();
      await expect(postText(page, '#post-grok')).toHaveText('元のポストは英語で書かれています。');
      await page.waitForTimeout(600);
      await expect(postText(page, '#post-grok')).toHaveText('元のポストは英語で書かれています。');
      expect((await presses(page))['post-grok:post']).toBe(1);

      // The popup's page button sends `restore` while translated: it stops for this tab.
      await commandPage(extension.worker, page, 'restore');
      await expect.poll(async () => (await pageState(extension.worker, page)).stopped).toBe(true);
      const stopped = await pageState(extension.worker, page);
      expect(stopped.active).toBe(false);
      expect(stopped.scope).toBe('x-body');
      await expect(postText(page, '#post-note')).not.toContainText('§');
      await expect(postText(page, '#post-note')).toContainText('这是一条用中文写的帖子。');

      // While stopped, a newly loaded post still gets its original back but no translation.
      await page.evaluate((html) => {
        const cell = document.createElement('div');
        cell.setAttribute('data-testid', 'cellInnerDiv');
        cell.innerHTML = html
          .replace('id="post-grok"', 'id="post-new"')
          .replace(/\/status\/1001/g, '/status/1099');
        document.querySelector('[aria-label="Timeline: Your Home Timeline"]')?.append(cell);
      }, GROK_POST);
      await page.locator('#post-new').scrollIntoViewIfNeeded();
      await expect.poll(async () => (await presses(page))['post-new:post']).toBe(1);
      await expect(postText(page, '#post-new')).toHaveText(
        'The original post is written in English.',
      );

      // The page button again: it resumes, and the new post is translated.
      await commandPage(extension.worker, page, 'toggle');
      await expect(postText(page, '#post-new')).toContainText(MARK);
      const resumed = await pageState(extension.worker, page);
      expect(resumed.active).toBe(true);
      expect(resumed.stopped).toBeUndefined();
      expect((await presses(page))['post-new:post']).toBe(1);
    } finally {
      await extension.close();
    }
  });

  test('stops from the bar, which offers no "always translate this site"', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await openTimeline(extension.context, extension.worker, {
        translateXBody: false,
      });
      // The bar lives in a closed shadow root; open it for this test before the content
      // script arrives, which it does once the setting turns on.
      await openExtensionShadowRoots(extension.worker, page);
      await setXBodySetting(extension.worker, true);
      await waitTranslated(page);

      const bar = page.locator('sakutto-bar');
      await expect(bar.getByText('表示中のX本文を翻訳しました。')).toBeVisible();
      const always = bar.locator('button', { hasText: 'このサイトを常に翻訳します' });
      await expect(always).toHaveCount(1);
      await expect(always).toBeHidden();
      const stop = bar.getByRole('button', { name: 'X本文翻訳を停止' });
      await expect(stop).toBeVisible();
      await stop.click();

      await expect.poll(async () => (await pageState(extension.worker, page)).stopped).toBe(true);
      await expect(postText(page, '#post-grok')).toHaveText(
        'The original post is written in English.',
      );
      await expect(bar).toBeHidden();
      // A reload starts it again as the setting says.
      await page.reload();
      await waitTranslated(page);
      await expect(postText(page, '#post-grok')).toContainText(MARK);
    } finally {
      await extension.close();
    }
  });

  test('stops for a never rule and right away when the setting turns off', async () => {
    const extension = await loadExtension('en-US');
    try {
      const page = await openTimeline(extension.context, extension.worker, {
        translateXBody: true,
      });
      await waitTranslated(page);
      await revealNotePost(page);
      await expect(postText(page, '#post-grok')).toContainText(MARK);
      // English UI: the bar names X post translation in English.
      await expect(page.locator('sakutto-bar')).toHaveAttribute(
        'aria-label',
        'X post translation progress',
      );

      await setSiteRules(extension.worker, { 'x.com': { host: 'x.com', auto: 'never' } });
      await expect(postText(page, '#post-grok')).not.toContainText('§');
      await expect.poll(async () => (await pageState(extension.worker, page)).scope).toBe('page');
      expect((await pageState(extension.worker, page)).active).toBe(false);

      await setSiteRules(extension.worker, {});
      await expect(postText(page, '#post-grok')).toContainText(MARK);

      await setXBodySetting(extension.worker, false);
      await expect(postText(page, '#post-grok')).not.toContainText('§');
      // The original X already shows stays; Grok's translation is not brought back.
      await expect(postText(page, '#post-grok')).toHaveText(
        'The original post is written in English.',
      );
      expect(await presses(page)).toEqual(ALL_PRESSES);
      const off = await pageState(extension.worker, page);
      expect(off.active).toBe(false);
      expect(off.scope).toBe('page');
    } finally {
      await extension.close();
    }
  });

  test('keeps the lines of a multi-line post that X paints without <br>', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await openTimeline(extension.context, extension.worker, {
        translateXBody: true,
      });
      await waitTranslated(page);
      await page.locator('#post-multiline').scrollIntoViewIfNeeded();
      const post = postText(page, '#post-multiline');
      await expect(post).toContainText(MARK);

      // How many line boxes the post's text span is painted on.
      const paintedLines = () =>
        post.evaluate((element) => element.querySelector('span')?.getClientRects().length ?? 0);

      // innerText follows the rendering, so the newlines are still painted as line breaks.
      expect(await post.innerText()).toBe(
        `${MARK}Shipping today.\n\nThanks to all testers.\n${MARK}#release`,
      );
      expect(await post.locator('br').count()).toBe(0);
      const translatedLines = await paintedLines();

      // Back to the original: the text node gets its own newlines back.
      await commandPage(extension.worker, page, 'restore');
      await expect.poll(async () => (await pageState(extension.worker, page)).stopped).toBe(true);
      await expect(post).not.toContainText('§');
      expect(await post.innerText()).toBe('Shipping today.\n\nThanks to all testers.\n#release');
      expect(await post.evaluate((element) => element.querySelector('span')?.textContent)).toBe(
        'Shipping today.\n\nThanks to all testers.\n',
      );
      const originalLines = await paintedLines();
      expect(originalLines).toBeGreaterThanOrEqual(3);
      expect(translatedLines).toBe(originalLines);
    } finally {
      await extension.close();
    }
  });

  test('translates the title, headings, paragraphs, lists and captions of an Article', async () => {
    const extension = await loadExtension('ja');
    try {
      await mockX(extension.context);
      await resetExtensionStorage(extension.worker, { targetLanguage: 'ja', translateXBody: true });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/fixture_kappa/article/2001');
      await waitTranslated(page);

      const article = page.locator('[data-testid="twitterArticleReadView"]');
      await expect(article.locator('[data-testid="twitter-article-title"]')).toContainText(MARK);
      for (const text of [
        'Running a translation model locally',
        'Why it matters',
        'Nothing leaves the browser.',
        'It keeps working offline.',
        'A laptop running the model without a network.',
        'A closing paragraph that is long enough',
      ]) {
        await expect(
          article.locator('[data-block="true"]', { hasText: text }).last(),
        ).toContainText(MARK);
      }
      await expect(
        article.locator('[data-block="true"]', { hasText: '最後の段落' }),
      ).not.toContainText('§');
      await expect(article.locator('[itemprop="author"]')).not.toContainText('§');
      await expect(article.locator('[data-testid="UserCell"]')).not.toContainText('§');
    } finally {
      await extension.close();
    }
  });

  test('translates an Article from its first block, headings and short paragraphs first', async () => {
    const extension = await loadExtension('ja');
    try {
      await mockX(extension.context, { ttfbMs: 200, msPerChar: 4, deltas: 0 });
      await resetExtensionStorage(extension.worker, {
        targetLanguage: 'ja',
        translateXBody: false,
      });
      const page = await extension.context.newPage();
      await page.goto('https://x.com/fixture_kappa/article/2001');
      // The closing paragraph is the one block long enough to read as prose by its length
      // alone. It sits far below the first screen; every other block of the Article is on it.
      await page.addStyleTag({
        content: '[data-block][data-offset-key="i-0-0"] { margin-top: 2400px; }',
      });
      await recordRequestStarts(page);

      await setXBodySetting(extension.worker, true);
      await waitTranslated(page);

      // Every block of the Article reader is a `div`, heading or not, and all but the
      // closing paragraph are shorter than the length that reads as prose on a whole page.
      // Inside the X scope they all count as body copy, so the first screen goes first in
      // reading order and the long paragraph far below waits for it.
      expect(await requestStarts(page)).toEqual([
        'Notes on translating text on your own computer',
        'Running a translation model locally keeps your text on the device.',
        'Why it matters',
        'Nothing leaves the browser.',
        'It keeps working offline.',
        'A laptop running the model without a network.',
        // The closing paragraph, whose text the fixture gives in full.
        'A closing paragraph that is long enough to read as prose by its length alone, the way a whole-page translation ranks a block, so that the order it is translated in shows whether the short blocks above it are treated the same.',
      ]);
      const article = page.locator('[data-testid="twitterArticleReadView"]');
      await expect(
        article.locator('[data-block="true"]', { hasText: 'A closing paragraph' }),
      ).toContainText(MARK);
      await expect(
        article.locator('[data-block="true"]', { hasText: 'Why it matters' }),
      ).toContainText(MARK);
    } finally {
      await extension.close();
    }
  });

  test('starts from the settings switch on an open x.com tab without a reload', async () => {
    const extension = await loadExtension('ja');
    try {
      const page = await openTimeline(extension.context, extension.worker, {
        translateXBody: false,
      });
      await page.waitForTimeout(800);
      await expect(page.locator('html')).not.toHaveAttribute('data-sakutto-state', /.+/);
      expect(await presses(page)).toEqual({});

      const options = await extension.context.newPage();
      await options.goto(`chrome-extension://${extension.extensionId}/options.html`);
      const toggle = options.locator('[data-sakutto="x-body"]');
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toBeChecked();
      await expect(options.getByText('X本文翻訳', { exact: true })).toBeVisible();
      await toggle.check();
      await expect(toggle).toBeChecked();
      await expect(options.locator('[data-sakutto="x-body-denied"]')).toHaveCount(0);
      await options.close();

      await waitTranslated(page);
      await expect(postText(page, '#post-grok')).toContainText(MARK);
      expect((await presses(page))['post-grok:post']).toBe(1);
    } finally {
      await extension.close();
    }
  });
});
