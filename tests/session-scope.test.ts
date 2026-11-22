// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { uiShadow } from '@/dom/overlay';
import {
  PageSession,
  type PageEngine,
  type SessionPreferences,
  type SessionScope,
} from '@/dom/session';

const labels = {
  original: '原文',
  chromeNote: 'Chrome の内蔵翻訳',
  machine: 'PLaMo による機械翻訳です。',
  selectionPending: '翻訳しています…',
  selectionFailed: 'この選択範囲を翻訳できませんでした。',
  selectionTitle: '選択したテキスト',
  selectionIcon: '選択したテキストを翻訳します',
  selectionResize: '翻訳ポップアップの幅を変更します',
  selectionCopy: '訳文をコピー',
  selectionCopied: 'コピーしました',
  selectionCopyFailed: 'コピーできませんでした。',
  close: '閉じる',
  bilingualOn: '対訳',
  replaceOn: '置換',
  barLabel: '翻訳の進み具合',
  barProgress: (done: number, total: number) => `翻訳中 ${String(done)} / ${String(total)}`,
  barRate: (tokens: string, segments: string) => `${tokens} tok/s · ${segments} seg/s`,
  barDone: '翻訳しました。',
  barPartial: (blocks: number) => `残り ${String(blocks)} 件`,
  barOriginal: '原文に戻す',
  barAlways: 'このサイトを常に翻訳します',
  barAlwaysOn: 'このサイトは常に翻訳します。',
};

function preferences(overrides: Partial<SessionPreferences> = {}): SessionPreferences {
  return {
    targetLanguage: 'ja',
    targetExplicit: true,
    form: 'polite',
    display: 'replace',
    auto: 'ask',
    host: 'example.com',
    context: false,
    tier: 'c8',
    pace: 'quality',
    ...overrides,
  };
}

const translated: string[] = [];

/** The text the engine saw, without the placeholder tags that keep inline elements in place. */
function sentText(): string[] {
  return translated.map((text) => text.replace(/<\/?i\d+>/gu, ''));
}

const engine: PageEngine = {
  async *translate(segments) {
    for (const segment of segments) {
      translated.push(segment.text);
      yield { id: segment.id, final: `訳:${segment.text}`, engine: 'plamo' as const };
    }
  },
};

/** Elements marked `data-scope` are the only text the scoped session may translate. */
const scope: SessionScope = {
  name: 'test-scope',
  roots: (container) => container.querySelectorAll('[data-scope]'),
  touches: (node) => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return false;
    return (
      element.closest('[data-scope]') !== null || element.querySelector('[data-scope]') !== null
    );
  },
};

const sessions: PageSession[] = [];

function start(withScope: SessionScope | null = scope): PageSession {
  const session = new PageSession(document, {
    engine,
    labels,
    preferences: preferences(),
    scheduleFrame: (callback) => callback(),
    debounceMs: 10,
    scope: withScope,
  });
  sessions.push(session);
  return session;
}

async function settle(session: PageSession): Promise<void> {
  // MutationObserver callbacks and the debounced rescan both run after a macrotask.
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await session.whenIdle();
  }
}

afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  translated.length = 0;
  document.body.innerHTML = '';
  document.documentElement.lang = '';
  document.documentElement.removeAttribute('data-sakutto-source-lang');
});

describe('scoped page session', () => {
  it('translates only text inside the scope roots', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = `
      <nav><a href="/home">Home</a><span>Trending now in your area</span></nav>
      <article>
        <div class="name">Display Name Here</div>
        <div data-scope lang="en">This post is written in English.</div>
        <button>Reply to this post</button>
      </article>`;
    const session = start();
    await session.translate();
    await settle(session);

    expect(translated).toEqual(['This post is written in English.']);
    expect(document.querySelector('[data-scope]')?.textContent).toBe(
      '訳:This post is written in English.',
    );
    expect(document.querySelector('nav')?.textContent).toBe('HomeTrending now in your area');
    expect(document.querySelector('.name')?.textContent).toBe('Display Name Here');
    expect(document.querySelector('button')?.textContent).toBe('Reply to this post');
  });

  it('reads the language from the scope, not from the interface <html lang>', async () => {
    // The interface is Japanese; an untagged English note inside the scope is still foreign.
    document.documentElement.lang = 'ja';
    document.body.innerHTML = `
      <div data-scope>Readers added this note.</div>
      <div data-scope>これは日本語の本文です。</div>
      <div data-scope lang="ja">Grok が日本語に訳した本文</div>`;
    const session = start();
    await session.translate();
    await settle(session);

    expect(translated).toEqual(['Readers added this note.']);
  });

  it('leaves <html lang> alone and reports its scope instead of a page language', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<div data-scope>これは日本語です。</div>';
    const session = start();
    await session.translate();
    await settle(session);

    expect(document.documentElement.lang).toBe('ja');
    expect(document.documentElement.hasAttribute('data-sakutto-source-lang')).toBe(false);
    const view = session.state();
    expect(view.scope).toBe('test-scope');
    expect(view.pageLanguage).toBeNull();
    expect(view.sameLanguage).toBe(false);
    expect(view.total).toBe(0);

    session.restore();
    expect(document.documentElement.lang).toBe('ja');
  });

  it('picks up scope roots added later and ignores text added elsewhere', async () => {
    document.body.innerHTML = '<main id="feed"></main><aside id="side"></aside>';
    const session = start();
    await session.translate();
    await settle(session);

    const side = document.createElement('p');
    side.textContent = 'Who to follow this week';
    document.querySelector('#side')?.append(side);
    const post = document.createElement('div');
    post.setAttribute('data-scope', '');
    post.setAttribute('lang', 'en');
    post.textContent = 'A new post appeared in the feed.';
    document.querySelector('#feed')?.append(post);
    await settle(session);

    expect(translated).toEqual(['A new post appeared in the feed.']);
    expect(side.textContent).toBe('Who to follow this week');
  });

  it('translates a root once the page swaps its translation for the original', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<div data-scope lang="ja"><span>Grok の訳文です。</span></div>';
    const session = start();
    await session.translate();
    await settle(session);
    expect(translated).toEqual([]);

    // The site's own "show original" rewrites the same element in place.
    const root = document.querySelector('[data-scope]') as HTMLElement;
    root.setAttribute('lang', 'zh');
    (root.querySelector('span') as HTMLElement).textContent = '这是原文。';
    await settle(session);

    expect(sentText()).toEqual(['这是原文。']);
    expect(root.textContent).toBe('訳:这是原文。');
  });

  it('finds a root changed while its own paint was landing once asked to rescan', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = `
      <div data-scope lang="en"><span>Translated right away.</span></div>
      <div data-scope lang="ja" id="late"><span>サイトの訳文です。</span></div>`;
    const session = start();
    await session.translate();
    // Changed in the same turn as the first paint, so the observer batch is dropped.
    const late = document.querySelector('#late') as HTMLElement;
    late.setAttribute('lang', 'en');
    (late.querySelector('span') as HTMLElement).textContent = 'The page swapped this in.';
    session.rescan();
    await settle(session);

    expect(sentText().sort()).toEqual(['The page swapped this in.', 'Translated right away.']);
  });

  it('ignores a rescan request while it is not translating', async () => {
    document.body.innerHTML = '<div data-scope lang="en">Idle text.</div>';
    const session = start();
    session.rescan();
    await settle(session);
    expect(translated).toEqual([]);
  });

  it('drops a translated root when the page puts its own translation back', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<div data-scope lang="en"><span>Original English text.</span></div>';
    const session = start();
    await session.translate();
    await settle(session);
    const root = document.querySelector('[data-scope]') as HTMLElement;
    expect(root.textContent).toBe('訳:Original English text.');

    root.setAttribute('lang', 'ja');
    root.innerHTML = '<span>サイトが表示した訳文です。</span>';
    await settle(session);

    expect(root.textContent).toBe('サイトが表示した訳文です。');
    expect(sentText()).toEqual(['Original English text.']);
    expect(session.state().total).toBe(0);
  });

  it('puts a scoped translation back before switching to the whole page', async () => {
    document.body.innerHTML = `
      <p>Sidebar copy outside the scope.</p>
      <div data-scope lang="en">Scoped text inside.</div>`;
    const session = start();
    await session.translate();
    await settle(session);
    expect(document.querySelector('p')?.textContent).toBe('Sidebar copy outside the scope.');

    session.setScope(null);
    expect(session.state().active).toBe(false);
    expect(document.querySelector('[data-scope]')?.textContent).toBe('Scoped text inside.');
    expect(session.state().scope).toBe('page');

    await session.translate();
    await settle(session);
    expect(document.querySelector('p')?.textContent).toBe('訳:Sidebar copy outside the scope.');
  });
});

/** The bar's two buttons, in order: restore and "always translate this site". */
function barButtons(): HTMLButtonElement[] {
  const shadow = uiShadow(document.querySelector('sakutto-bar'));
  return [...(shadow?.querySelectorAll<HTMLButtonElement>('.actions button') ?? [])];
}

function barText(): string {
  return (
    uiShadow(document.querySelector('sakutto-bar'))?.querySelector('.bar > span')?.textContent ?? ''
  );
}

describe('page bar for a caller that owns the restore control', () => {
  it('hands the restore control to the caller instead of restoring', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<p data-scope lang="en">This post is written in English.</p>';
    let pressed = 0;
    const session = new PageSession(document, {
      engine,
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      debounceMs: 10,
      scope,
      onBarOriginal: () => {
        pressed += 1;
      },
    });
    sessions.push(session);
    await session.translate();
    await settle(session);
    expect(session.isActive()).toBe(true);

    barButtons()[0]?.click();
    expect(pressed).toBe(1);
    // The caller decides; the session did not restore on its own.
    expect(session.isActive()).toBe(true);
  });

  it('hides "always translate this site" when asked and shows it again', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<p data-scope lang="en">This post is written in English.</p>';
    const session = new PageSession(document, {
      engine,
      labels,
      preferences: preferences(),
      scheduleFrame: (callback) => callback(),
      debounceMs: 10,
      scope,
      barAlwaysShown: false,
    });
    sessions.push(session);
    await session.translate();
    await settle(session);
    const always = barButtons()[1];
    expect(always?.hidden).toBe(true);
    expect(always?.style.display).toBe('none');

    session.setBarAlwaysShown(true);
    expect(always?.hidden).toBe(false);
    expect(always?.style.display).toBe('');
  });

  it('rewords a running bar as soon as the labels change', async () => {
    document.documentElement.lang = 'ja';
    document.body.innerHTML = '<p data-scope lang="en">This post is written in English.</p>';
    const session = start();
    await session.translate();
    await settle(session);
    expect(barText()).toBe(labels.barDone);

    session.setLabels({ ...labels, barDone: '表示中のX本文を翻訳しました。', barOriginal: '停止' });
    expect(barText()).toBe('表示中のX本文を翻訳しました。');
    expect(barButtons()[0]?.textContent).toBe('停止');
  });
});
