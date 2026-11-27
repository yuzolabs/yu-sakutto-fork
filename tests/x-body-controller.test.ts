// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { uiShadow, type OverlayLabels } from '@/dom/overlay';
import { PageSession, type PageEngine, type SessionPreferences } from '@/dom/session';
import { XBodyController, type XBodyConditions } from '@/dom/x-body/controller';
import { fixturePresses, loadXFixture } from './support/x-fixture';

const translated: string[] = [];
const engine: PageEngine = {
  async *translate(segments) {
    for (const segment of segments) {
      translated.push(segment.text.replace(/<\/?i\d+>/gu, ''));
      yield { id: segment.id, final: `[ja] ${segment.text}`, engine: 'plamo' as const };
    }
  },
};

const labels: OverlayLabels = {
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
  barLabel: 'page',
  barProgress: () => 'page progress',
  barRate: () => '',
  barDone: 'page done',
  barPartial: () => '',
  barOriginal: 'Show original',
  barAlways: 'Always translate this site',
  barAlwaysOn: '',
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

let cleanup: (() => void) | null = null;
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers.length = 0;
  cleanup?.();
  cleanup = null;
  translated.length = 0;
  document.body.innerHTML = '';
  document.documentElement.lang = '';
  delete document.documentElement.dataset.fixturePresses;
});

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(session: PageSession): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await tick(40);
    await session.whenIdle();
  }
}

function text(selector: string): string {
  return (document.querySelector(selector)?.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/** The bar's two buttons, in order: restore (stop here) and "always translate this site". */
function barButton(name: 'original' | 'always'): HTMLButtonElement | null {
  const buttons = uiShadow(document.querySelector('sakutto-bar'))?.querySelectorAll(
    '.actions button',
  );
  return (buttons?.[name === 'original' ? 0 : 1] as HTMLButtonElement | undefined) ?? null;
}

function setup(options: { eligible?: boolean; now?: () => number } = {}) {
  cleanup = loadXFixture('x-body.html', document);
  // A Grok-translated post as X first draws it, to add "newly loaded" posts later.
  const grokPost = document.querySelector('#post-grok')?.outerHTML ?? '';
  const modes: boolean[] = [];
  let starts = 0;
  let controller: XBodyController | null = null;
  const session = new PageSession(document, {
    engine,
    labels,
    preferences: preferences(),
    scheduleFrame: (callback) => callback(),
    debounceMs: 10,
    onBarOriginal: () => controller?.stop(),
  });
  controller = new XBodyController(document, session, {
    eligible: options.eligible ?? true,
    onModeChange: (on) => modes.push(on),
    onStart: () => {
      starts += 1;
    },
    unlocker: { debounceMs: 5, isNearViewport: () => true },
    ...(options.now ? { now: options.now } : {}),
  });
  disposers.push(() => {
    controller.dispose();
    session.dispose();
  });
  const conditions: XBodyConditions = { settingOn: true, auto: 'ask', ready: true };
  return {
    session,
    controller,
    modes,
    starts: () => starts,
    /** Appends a freshly loaded Grok-translated post with the given ID. */
    addPost: (id: string, statusId: string) => {
      const cell = document.createElement('div');
      cell.setAttribute('data-testid', 'cellInnerDiv');
      cell.innerHTML = grokPost
        .replace('id="post-grok"', `id="${id}"`)
        .replace('/status/1001', `/status/${statusId}`);
      document.querySelector('[aria-label="Timeline: Your Home Timeline"]')?.append(cell);
    },
    update: (patch: Partial<XBodyConditions> = {}) => {
      Object.assign(conditions, patch);
      controller.update({ ...conditions });
    },
  };
}

describe('X post translation in one tab', () => {
  it('turns off Grok translations and translates only X text once Sakutto can translate', async () => {
    const { session, controller, modes, starts, update } = setup();
    update();
    await settle(session);

    expect(controller.active).toBe(true);
    expect(modes).toEqual([true]);
    expect(starts()).toBe(1);
    expect(session.state().scope).toBe('x-body');
    expect(session.state().active).toBe(true);
    expect([...controller.unlockedIds()].sort()).toEqual(['note:1005', 'post:1001', 'post:1005']);
    expect(translated).toContain('The original post is written in English.');
    expect(translated).toContain(
      'Readers noted that the quoted figure leaves out the second survey.',
    );
    // X's labels, names and trends stay as they are.
    expect(text('[data-testid="trend"]')).toBe('Trending topic written in English');
    expect(text('#post-grok [data-testid="User-Name"] a span')).toBe('Alpha Writer');
    expect(document.documentElement.lang).toBe('ja');
  });

  it('presses nothing and translates nothing while Sakutto cannot translate', async () => {
    const { session, controller, starts, update } = setup();
    update({ ready: false });
    await settle(session);

    expect(controller.active).toBe(true);
    expect(fixturePresses(document)).toEqual({});
    expect(session.state().active).toBe(false);
    expect(starts()).toBe(0);
    expect(text('#post-grok [data-testid="tweetText"]')).toBe('元のポストは英語で書かれています。');

    // The model finished loading.
    update({ ready: true });
    await settle(session);
    expect(fixturePresses(document)['post-grok:post']).toBe(1);
    expect(session.state().active).toBe(true);
    expect(translated).toContain('The original post is written in English.');
  });

  it('does nothing when the setting is off, the rule is never, or the tab is not eligible', async () => {
    const off = setup();
    off.update({ settingOn: false });
    off.update({ settingOn: true, auto: 'never' });
    await settle(off.session);
    expect(off.controller.active).toBe(false);
    expect(fixturePresses(document)).toEqual({});
    expect(off.session.state().active).toBe(false);
    expect(off.session.state().scope).toBe('page');
    for (const dispose of disposers.splice(0)) dispose();
    cleanup?.();

    const ineligible = setup({ eligible: false });
    ineligible.update();
    await settle(ineligible.session);
    expect(ineligible.controller.active).toBe(false);
    expect(ineligible.modes).toEqual([]);
    expect(fixturePresses(document)).toEqual({});
  });

  it('stops and resumes from the page button while Grok translations keep being turned off', async () => {
    let clock = 0;
    const { session, controller, update, addPost } = setup({ now: () => clock });
    update();
    await settle(session);
    expect(text('#post-grok [data-testid="tweetText"]')).toContain('[ja]');

    await controller.toggle('toggle');
    expect(session.state().active).toBe(false);
    expect(controller.stopped).toBe(true);
    expect(text('#post-grok [data-testid="tweetText"]')).toBe(
      'The original post is written in English.',
    );

    // A post that loads while stopped still gets its original back, but no translation.
    addPost('post-new', '1099');
    await settle(session);
    expect(fixturePresses(document)['post-new:post']).toBe(1);
    expect(text('#post-new [data-testid="tweetText"]')).toBe(
      'The original post is written in English.',
    );

    // A second delivery of the same shortcut is ignored.
    await controller.toggle('toggle');
    expect(controller.stopped).toBe(true);

    clock += 1000;
    await controller.toggle('toggle');
    await settle(session);
    expect(controller.stopped).toBe(false);
    expect(session.state().active).toBe(true);
    expect(session.state().scope).toBe('x-body');
    expect(text('#post-new [data-testid="tweetText"]')).toContain('[ja]');
  });

  it('turns the bar restore control into stop and hides "always translate this site"', async () => {
    const { session, controller, update } = setup();
    update();
    await settle(session);

    expect(barButton('always')?.hidden).toBe(true);
    expect(barButton('always')?.style.display).toBe('none');
    barButton('original')?.click();
    expect(controller.stopped).toBe(true);
    expect(session.state().active).toBe(false);
    // Stopping is per tab: the controller is still on and a resume starts again.
    await controller.resume();
    await settle(session);
    expect(session.state().active).toBe(true);
  });

  it('puts Sakutto translations back when the setting turns off but keeps X originals', async () => {
    const { session, controller, modes, update, addPost } = setup();
    update();
    await settle(session);
    expect(text('#post-grok [data-testid="tweetText"]')).toContain('[ja]');

    update({ settingOn: false });
    expect(controller.active).toBe(false);
    expect(modes).toEqual([true, false]);
    expect(session.state().active).toBe(false);
    expect(session.state().scope).toBe('page');
    // The original X already shows stays; the Grok translation is not brought back.
    expect(text('#post-grok [data-testid="tweetText"]')).toBe(
      'The original post is written in English.',
    );
    expect(fixturePresses(document)['post-grok:post']).toBe(1);

    // No more presses after it turned off.
    addPost('post-late', '1098');
    await tick(60);
    expect(fixturePresses(document)['post-late:post']).toBeUndefined();
  });

  it('stops for a never rule and starts again when the rule allows it', async () => {
    const { session, controller, update } = setup();
    update({ auto: 'always' });
    await settle(session);
    expect(session.state().active).toBe(true);

    update({ auto: 'never' });
    expect(controller.active).toBe(false);
    expect(session.state().active).toBe(false);

    update({ auto: 'ask' });
    await settle(session);
    expect(controller.active).toBe(true);
    expect(session.state().active).toBe(true);
  });
});
