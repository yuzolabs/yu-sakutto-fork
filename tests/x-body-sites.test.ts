import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  firefox: false,
  allSites: false,
  granted: new Set<string>(),
  requestResult: false,
  requests: [] as string[][],
  settings: { translateXBody: false } as { translateXBody: boolean },
  tabs: [] as Array<{ id?: number; url?: string }>,
  injected: [] as number[],
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test${path}` },
    i18n: { getMessage: (key: string) => key, getUILanguage: () => 'en-US' },
    commands: { onCommand: { addListener: () => undefined } },
    contextMenus: {
      onClicked: { addListener: () => undefined },
      removeAll: (callback: () => void) => callback(),
      create: (_properties: unknown, callback: () => void) => callback(),
    },
    tabs: {
      query: async () => state.tabs,
      onUpdated: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) =>
        origins.every((origin) => state.granted.has(origin)),
      request: async ({ origins }: { origins: string[] }) => {
        state.requests.push(origins);
        return state.requestResult;
      },
    },
  },
}));

vi.mock('@/shared/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/browser')>();
  return { ...actual, isFirefoxBuild: () => state.firefox };
});

vi.mock('@/dom/all-sites', () => ({
  allSitesGrantCoversOrigins: () => state.allSites,
}));

vi.mock('@/shared/storage', () => ({
  loadSettings: async () => state.settings,
}));

vi.mock('@/shared/page-bridge', () => ({
  ensureContentScript: async (tabId: number) => {
    state.injected.push(tabId);
    return true;
  },
}));

const {
  X_BODY_ORIGIN,
  isXBodyHost,
  isXBodyPageUrl,
  requestXBodyHostAccess,
  resolveXBodyToggle,
  shouldAutoInjectXBody,
  xBodyOriginsOverlap,
  xBodyPermissionOrigins,
  xBodySupported,
} = await import('@/dom/x-body/sites');
const { injectIfXBody, injectXBodyPages } = await import('@/background/page-actions');

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  state.firefox = false;
  state.allSites = false;
  state.granted = new Set();
  state.requestResult = false;
  state.requests = [];
  state.settings = { translateXBody: false };
  state.tabs = [];
  state.injected = [];
});

describe('X post translation hosts', () => {
  it('accepts only x.com itself', () => {
    expect(isXBodyHost('x.com')).toBe(true);
    expect(isXBodyHost('X.COM.')).toBe(true);
    expect(isXBodyHost('www.x.com')).toBe(false);
    expect(isXBodyHost('mobile.x.com')).toBe(false);
    expect(isXBodyHost('twitter.com')).toBe(false);
    expect(isXBodyHost('mobile.twitter.com')).toBe(false);
    expect(isXBodyHost('notx.com')).toBe(false);
  });

  it('accepts only https pages on x.com', () => {
    expect(isXBodyPageUrl('https://x.com/home')).toBe(true);
    expect(isXBodyPageUrl('https://x.com/someone/status/1')).toBe(true);
    expect(isXBodyPageUrl('http://x.com/home')).toBe(false);
    expect(isXBodyPageUrl('https://www.x.com/home')).toBe(false);
    expect(isXBodyPageUrl('https://twitter.com/home')).toBe(false);
    expect(isXBodyPageUrl('chrome://extensions')).toBe(false);
    expect(isXBodyPageUrl('not a url')).toBe(false);
  });

  it('requests only the x.com origin', () => {
    expect(xBodyPermissionOrigins()).toEqual(['https://x.com/*']);
    expect(X_BODY_ORIGIN).toBe('https://x.com/*');
    expect(xBodyOriginsOverlap(['https://x.com/*', 'https://www.youtube.com/*'])).toBe(true);
    expect(xBodyOriginsOverlap(['https://www.x.com/*'])).toBe(false);
    expect(xBodyOriginsOverlap(undefined)).toBe(false);
  });

  it('injects only when the setting, the origin, and the page all match', () => {
    const base = { settingOn: true, url: 'https://x.com/home', originAllowed: true };
    expect(shouldAutoInjectXBody(base)).toBe(true);
    expect(shouldAutoInjectXBody({ ...base, settingOn: false })).toBe(false);
    expect(shouldAutoInjectXBody({ ...base, originAllowed: false })).toBe(false);
    expect(shouldAutoInjectXBody({ ...base, url: 'https://twitter.com/home' })).toBe(false);
    expect(shouldAutoInjectXBody({ ...base, supported: false })).toBe(false);
  });

  it('is unavailable in the Firefox build', () => {
    expect(xBodySupported()).toBe(true);
    state.firefox = true;
    expect(xBodySupported()).toBe(false);
  });
});

describe('X post translation host access', () => {
  it('asks Chrome for the x.com origin when no broad grant covers it', async () => {
    state.requestResult = true;
    await expect(requestXBodyHostAccess()).resolves.toBe(true);
    expect(state.requests).toEqual([['https://x.com/*']]);
  });

  it('skips the prompt when the all-sites grant already covers x.com', async () => {
    state.allSites = true;
    await expect(requestXBodyHostAccess()).resolves.toBe(true);
    expect(state.requests).toEqual([]);
  });

  it('turns the setting on only after a grant and reports a denial', async () => {
    await expect(resolveXBodyToggle(false, async () => true)).resolves.toEqual({
      on: false,
      denied: false,
    });
    await expect(resolveXBodyToggle(true, async () => true)).resolves.toEqual({
      on: true,
      denied: false,
    });
    await expect(resolveXBodyToggle(true, async () => false)).resolves.toEqual({
      on: false,
      denied: true,
    });
  });

  it('does not ask for access when turning the setting off', async () => {
    const request = vi.fn(async () => true);
    await resolveXBodyToggle(false, request);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('X post translation injection', () => {
  it('injects an x.com tab once the setting is on and the origin is granted', async () => {
    state.settings = { translateXBody: true };
    state.granted.add('https://x.com/*');
    await injectIfXBody(7, 'https://x.com/home');
    expect(state.injected).toEqual([7]);
  });

  it('leaves other hosts, missing grants, and the off setting alone', async () => {
    state.settings = { translateXBody: true };
    await injectIfXBody(1, 'https://x.com/home');
    state.granted.add('https://x.com/*');
    await injectIfXBody(2, 'https://www.x.com/home');
    await injectIfXBody(3, 'https://twitter.com/home');
    state.settings = { translateXBody: false };
    await injectIfXBody(4, 'https://x.com/home');
    expect(state.injected).toEqual([]);
  });

  it('sweeps the open x.com tabs after the setting turns on', async () => {
    state.settings = { translateXBody: true };
    state.granted.add('https://x.com/*');
    state.tabs = [
      { id: 1, url: 'https://x.com/home' },
      { id: 2, url: 'https://example.com/' },
      { id: 3, url: 'https://x.com/someone/status/1' },
      { url: 'https://x.com/no-id' },
    ];
    await injectXBodyPages();
    await settle();
    expect(state.injected.sort()).toEqual([1, 3]);
  });

  it('re-injects from the worker on a setting change, a new grant, and startup', () => {
    const background = readFileSync(
      new URL('../src/entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    const actions = readFileSync(
      new URL('../src/background/page-actions.ts', import.meta.url),
      'utf8',
    );
    expect(background.match(/injectXBodyPages\(\)/gu)?.length).toBe(3);
    expect(background).toContain('if (settings.translateXBody) void injectXBodyPages();');
    expect(actions).toContain('void injectIfXBody(tabId, tab.url);');
  });

  it('never injects in the Firefox build', async () => {
    state.firefox = true;
    state.settings = { translateXBody: true };
    state.granted.add('https://x.com/*');
    state.tabs = [{ id: 1, url: 'https://x.com/home' }];
    await injectIfXBody(1, 'https://x.com/home');
    await injectXBodyPages();
    await settle();
    expect(state.injected).toEqual([]);
  });
});
