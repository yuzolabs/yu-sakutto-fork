// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { PageSession, type PageEngine, type SessionPreferences } from '@/dom/session';
import {
  GrokUnlocker,
  findShowOriginalControls,
  showOriginalLabel,
  type ShowOriginalControl,
} from '@/dom/x-body/grok';
import {
  X_BODY_SCOPE_NAME,
  articleIdFor,
  statusIdFor,
  touchesXBody,
  xBodyRoots,
  xBodyScope,
} from '@/dom/x-body/locate';
import { fixturePresses, loadXFixture } from './support/x-fixture';

let cleanup: (() => void) | null = null;
const unlockers: GrokUnlocker[] = [];
const sessions: PageSession[] = [];

function load(name: 'x-body.html' | 'x-article.html'): void {
  cleanup?.();
  cleanup = loadXFixture(name, document);
}

afterEach(() => {
  for (const unlocker of unlockers) unlocker.stop();
  unlockers.length = 0;
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
  document.documentElement.lang = '';
  delete document.documentElement.dataset.fixturePresses;
});

function text(selector: string): string {
  return (document.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function rootTexts(): string[] {
  return xBodyRoots(document).map((root) => (root.textContent ?? '').replace(/\s+/gu, ' ').trim());
}

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function unlocker(options: Partial<ConstructorParameters<typeof GrokUnlocker>[1]> = {}): {
  unlocker: GrokUnlocker;
  pressed: ShowOriginalControl[];
} {
  const pressed: ShowOriginalControl[] = [];
  const created = new GrokUnlocker(document, {
    canUnlock: () => true,
    debounceMs: 5,
    isNearViewport: () => true,
    onUnlock: (control) => pressed.push(control),
    ...options,
  });
  unlockers.push(created);
  return { unlocker: created, pressed };
}

describe('X text roots', () => {
  it('finds post text, quoted posts, note text and article previews only', () => {
    load('x-body.html');
    expect(rootTexts()).toEqual([
      '元のポストは英語で書かれています。',
      'これは最初から日本語で書かれたポストです。',
      'X left this English post as it was written. #fixture',
      '引用元のポストを紹介します。',
      '引用されたポストは Grok が日本語に訳したものです。',
      'This quoted post was never translated by X.',
      'これは中国語で書かれたポストです。',
      '読者は、引用された数字には2回目の調査が含まれていないと指摘しました。',
      '新しい記事を書きました。',
      'How small models translate on a laptop A short look at running a translation model locally.',
      '投票とリンクです。',
    ]);
  });

  it('leaves names, trends, buttons, polls, link cards and X labels out', () => {
    load('x-body.html');
    const joined = rootTexts().join('\n');
    for (const outside of [
      'Alpha Writer',
      'Trending topic written in English',
      'Home timeline',
      'Option one for the poll',
      'An outside news headline written in English',
      '閲覧したユーザーが背景情報を追加しました',
      '役に立ちましたか',
      '英語からの翻訳',
      '原文を表示',
      'さらに表示',
      'Article',
    ]) {
      expect(joined).not.toContain(outside);
    }
  });

  it('finds the title, paragraphs, headings, list items and captions of an Article', () => {
    load('x-article.html');
    expect(rootTexts()).toEqual([
      'Notes on translating text on your own computer',
      'Running a translation model locally keeps your text on the device.',
      'Why it matters',
      'Nothing leaves the browser.',
      'It keeps working offline.',
      'A laptop running the model without a network.',
      '最後の段落は日本語で書かれています。',
    ]);
    const joined = rootTexts().join('\n');
    expect(joined).not.toContain('Kappa Author');
    expect(joined).not.toContain('Follow this author');
    expect(joined).not.toContain('GIF');
  });

  it('reports mutations inside or around X text and ignores the rest of the page', () => {
    load('x-body.html');
    const postSpan = document.querySelector('#post-japanese [data-testid="tweetText"] span');
    const cell = document.querySelector('[data-testid="cellInnerDiv"]');
    const preview = document.querySelector('.preview-text span');
    const trend = document.querySelector('[data-testid="trend"] span');
    const name = document.querySelector('#post-japanese [data-testid="User-Name"] span');
    expect(postSpan && touchesXBody(postSpan.firstChild as Node)).toBe(true);
    expect(cell && touchesXBody(cell)).toBe(true);
    expect(preview && touchesXBody(preview)).toBe(true);
    expect(trend && touchesXBody(trend)).toBe(false);
    expect(name && touchesXBody(name)).toBe(false);

    const detached = document.createElement('div');
    detached.innerHTML = '<div data-testid="tweetText">removed</div>';
    expect(touchesXBody(detached)).toBe(true);
  });

  it('names its scope for the page state', () => {
    expect(xBodyScope().name).toBe(X_BODY_SCOPE_NAME);
    expect(X_BODY_SCOPE_NAME).toBe('x-body');
  });
});

describe('X item IDs', () => {
  it('reads a post ID from its timestamp permalink', () => {
    load('x-body.html');
    const post = document.querySelector('#post-grok [data-testid="tweetText"]');
    expect(post && statusIdFor(post)).toBe('1001');
  });

  it('gives a quoted post without a permalink no ID instead of the outer one', () => {
    load('x-body.html');
    const quoted = document.querySelector('[data-fixture="quote-grok"] [data-testid="tweetText"]');
    expect(quoted && statusIdFor(quoted)).toBeNull();
    const outer = document.querySelector('#post-quote > div > [data-testid="tweetText"]');
    expect(outer && statusIdFor(outer)).toBe('1004');
  });

  it('gives a note the ID of the post it belongs to', () => {
    load('x-body.html');
    const note = document.querySelector('[data-testid="birdwatch-pivot"]');
    expect(note && statusIdFor(note)).toBe('1005');
  });

  it('reads an Article ID from the address or the caption anchors', () => {
    load('x-article.html');
    const view = document.querySelector('[data-testid="twitterArticleReadView"]') as Element;
    expect(articleIdFor(view, 'https://x.com/fixture_kappa/article/2001')).toBe('2001');
    expect(articleIdFor(view, 'https://x.com/fixture_kappa/status/3001')).toBe('3001');
    expect(articleIdFor(view, 'https://x.com/i/bookmarks')).toBe('2001');
  });
});

describe('X "Show original" controls', () => {
  it('knows the label only in Japanese and English', () => {
    expect(showOriginalLabel('ja')).toBe('原文を表示');
    expect(showOriginalLabel('ja-JP')).toBe('原文を表示');
    expect(showOriginalLabel('en')).toBe('Show original');
    expect(showOriginalLabel('en-GB')).toBe('Show original');
    expect(showOriginalLabel('ko')).toBeNull();
    expect(showOriginalLabel('zh-Hans')).toBeNull();
    expect(showOriginalLabel('')).toBeNull();
    expect(showOriginalLabel(null)).toBeNull();
  });

  it('finds the post and note controls with their IDs', () => {
    load('x-body.html');
    const found = findShowOriginalControls(document, '原文を表示', 'https://x.com/home');
    expect(found.map((entry) => [entry.id, entry.kind])).toEqual([
      ['post:1001', 'post'],
      ['post:1005', 'post'],
      ['note:1005', 'note'],
    ]);
  });

  it('ignores a "Show translation" control and a label outside any known row', () => {
    load('x-body.html');
    const first = document.querySelector(
      '#post-grok button[aria-label="原文を表示"]',
    ) as HTMLElement;
    first.click();
    expect(first.getAttribute('aria-label')).toBe('翻訳を表示');
    const stray = document.createElement('button');
    stray.setAttribute('aria-label', '原文を表示');
    document.querySelector('[data-testid="sidebarColumn"]')?.append(stray);

    const found = findShowOriginalControls(document, '原文を表示', 'https://x.com/home');
    expect(found.map((entry) => entry.id)).toEqual(['post:1005', 'note:1005']);
  });

  it('matches the English label when X is shown in English', () => {
    load('x-body.html');
    document.documentElement.lang = 'en';
    for (const button of document.querySelectorAll('button[aria-label="原文を表示"]')) {
      button.setAttribute('aria-label', 'Show original');
    }
    const found = findShowOriginalControls(document, 'Show original', 'https://x.com/home');
    expect(found.map((entry) => entry.id)).toEqual(['post:1001', 'post:1005', 'note:1005']);
  });

  it('finds a control on an Article page and keys it by the Article', () => {
    load('x-article.html');
    const title = document.querySelector('[data-testid="twitter-article-title"]') as Element;
    const row = document.createElement('div');
    row.setAttribute('dir', 'ltr');
    row.innerHTML =
      '<span>英語からの翻訳</span><button aria-label="原文を表示" type="button"></button>';
    title.before(row);
    const found = findShowOriginalControls(
      document,
      '原文を表示',
      'https://x.com/fixture_kappa/article/2001',
    );
    expect(found.map((entry) => [entry.id, entry.kind])).toEqual([['article:2001', 'article']]);
  });
});

describe('Grok translation unlocker', () => {
  it('presses each item once and X shows the original text', async () => {
    load('x-body.html');
    const { unlocker: created, pressed } = unlocker();
    created.start();
    await tick();

    expect(pressed.map((entry) => entry.id)).toEqual(['post:1001', 'post:1005', 'note:1005']);
    expect(fixturePresses(document)).toEqual({
      'post-grok:post': 1,
      'post-note:post': 1,
      'post-note:note': 1,
    });
    expect(text('#post-grok [data-testid="tweetText"]')).toBe(
      'The original post is written in English.',
    );
    expect(
      document.querySelector('#post-grok [data-testid="tweetText"]')?.getAttribute('lang'),
    ).toBe('en');
    expect(text('[data-testid="birdwatch-pivot"] > div[dir]')).toBe(
      'Readers noted that the quoted figure leaves out the second survey.',
    );
  });

  it('presses nothing while Sakutto cannot translate, then catches up', async () => {
    load('x-body.html');
    let ready = false;
    const { unlocker: created, pressed } = unlocker({ canUnlock: () => ready });
    created.start();
    await tick();
    expect(pressed).toEqual([]);
    expect(fixturePresses(document)).toEqual({});

    ready = true;
    created.sweep();
    expect(pressed.map((entry) => entry.id)).toEqual(['post:1001', 'post:1005', 'note:1005']);
  });

  it('leaves the item alone after the reader switches back to the Grok translation', async () => {
    load('x-body.html');
    const { unlocker: created } = unlocker();
    created.start();
    await tick();

    const button = document.querySelector(
      '#post-grok button[aria-label="翻訳を表示"]',
    ) as HTMLElement;
    button.click();
    await tick();
    created.sweep();
    await tick();

    expect(text('#post-grok [data-testid="tweetText"]')).toBe('元のポストは英語で書かれています。');
    expect(fixturePresses(document)['post-grok:post']).toBe(1);
  });

  it('treats a rebuilt post with the same ID as the same item', async () => {
    load('x-body.html');
    const original = document.querySelector('#post-grok')?.outerHTML ?? '';
    const { unlocker: created } = unlocker();
    created.start();
    await tick();

    // X rebuilds the post when it scrolls back into view, showing its translation again.
    const cell = document.querySelector('#post-grok')?.parentElement as HTMLElement;
    cell.innerHTML = original;
    await tick();
    created.sweep();

    expect(fixturePresses(document)['post-grok:post']).toBe(1);
    expect(created.pressedIds().has('post:1001')).toBe(true);
  });

  it('presses a newly loaded item with a new ID', async () => {
    load('x-body.html');
    const template = document.querySelector('#post-grok')?.outerHTML ?? '';
    const { unlocker: created, pressed } = unlocker();
    created.start();
    await tick();

    const cell = document.createElement('div');
    cell.setAttribute('data-testid', 'cellInnerDiv');
    cell.innerHTML = template
      .replace('id="post-grok"', 'id="post-new"')
      .replace('/status/1001', '/status/1099');
    document.querySelector('[aria-label="Timeline: Your Home Timeline"]')?.append(cell);
    await tick();

    expect(pressed.map((entry) => entry.id)).toContain('post:1099');
    expect(fixturePresses(document)['post-new:post']).toBe(1);
  });

  it('presses nothing for an interface language it cannot read', async () => {
    load('x-body.html');
    document.documentElement.lang = 'ko';
    const { unlocker: created, pressed } = unlocker();
    created.start();
    await tick();
    expect(pressed).toEqual([]);
  });

  it('waits until an item is near the screen', async () => {
    load('x-body.html');
    let near = false;
    const { unlocker: created, pressed } = unlocker({ isNearViewport: () => near });
    created.start();
    await tick();
    expect(pressed).toEqual([]);

    near = true;
    document.dispatchEvent(new Event('scroll'));
    await tick();
    expect(pressed.length).toBe(3);
  });

  it('stops pressing after stop()', async () => {
    load('x-body.html');
    let ready = false;
    const { unlocker: created, pressed } = unlocker({ canUnlock: () => ready });
    created.start();
    created.stop();
    ready = true;
    created.sweep();
    await tick();
    expect(created.running).toBe(false);
    expect(pressed).toEqual([]);
  });
});

describe('X post translation on the synthetic timeline', () => {
  const translated: string[] = [];
  const engine: PageEngine = {
    async *translate(segments) {
      for (const segment of segments) {
        translated.push(segment.text.replace(/<\/?i\d+>/gu, ''));
        yield { id: segment.id, final: `[ja] ${segment.text}`, engine: 'plamo' as const };
      }
    },
  };

  function preferences(): SessionPreferences {
    return {
      targetLanguage: 'ja',
      targetExplicit: true,
      form: 'polite',
      display: 'replace',
      auto: 'ask',
      host: 'x.com',
      context: false,
      tier: 'c8',
      pace: 'quality',
    };
  }

  afterEach(() => {
    translated.length = 0;
  });

  async function settle(session: PageSession): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      await tick(40);
      await session.whenIdle();
    }
  }

  it('unlocks Grok translations and translates only foreign X text', async () => {
    load('x-body.html');
    const session = new PageSession(document, {
      engine,
      labels: {
        original: '原文',
        chromeNote: '',
        machine: '',
        selectionPending: '',
        selectionFailed: '',
        selectionTitle: '',
        selectionIcon: '',
        selectionResize: '',
        selectionCopy: '',
        selectionCopied: '',
        selectionCopyFailed: '',
        close: '',
        bilingualOn: '',
        replaceOn: '',
        barLabel: '',
        barProgress: () => '',
        barRate: () => '',
        barDone: '',
        barPartial: () => '',
        barOriginal: '',
        barAlways: '',
        barAlwaysOn: '',
      },
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      debounceMs: 10,
      scope: xBodyScope(),
    });
    sessions.push(session);
    await session.translate();
    // The content script wires the two together the same way: a press asks for a rescan.
    const { unlocker: created } = unlocker({ onUnlock: () => session.rescan() });
    created.start();
    await settle(session);

    expect(translated.sort()).toEqual(
      [
        'The original post is written in English.',
        'X left this English post as it was written. #fixture',
        'This quoted post was never translated by X.',
        '这是一条用中文写的帖子。',
        'Readers noted that the quoted figure leaves out the second survey.',
        'How small models translate on a laptop',
        'A short look at running a translation model locally.',
      ].sort(),
    );
    expect(text('#post-japanese [data-testid="tweetText"]')).toBe(
      'これは最初から日本語で書かれたポストです。',
    );
    expect(text('[data-fixture="quote-grok"] [data-testid="tweetText"]')).toBe(
      '引用されたポストは Grok が日本語に訳したものです。',
    );
    expect(text('[data-testid="trend"]')).toBe('Trending topic written in English');
    expect(text('[data-testid="cardPoll"]')).toBe(
      'Option one for the poll Option two for the poll',
    );
    expect(text('#post-grok [data-testid="User-Name"] a span')).toBe('Alpha Writer');
    expect(document.documentElement.lang).toBe('ja');
    expect(session.state().scope).toBe('x-body');
  });
});
