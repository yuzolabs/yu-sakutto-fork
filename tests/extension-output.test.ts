import { resolve, sep } from 'node:path';
import type { UserConfig } from 'wxt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_OUTPUT_DIR,
  RELEASE_OUTPUT_DIR,
  chromeExtensionDir,
  extensionOutputDir,
  isFixtureBuild,
} from '../scripts/extension-output.ts';

const BUILD_FLAG_MATRIX: Array<[string, Record<string, string>, boolean, string]> = [
  ['no build flag', {}, false, RELEASE_OUTPUT_DIR],
  ['SAKUTTO_FAKE_ENGINE=1', { SAKUTTO_FAKE_ENGINE: '1' }, true, FIXTURE_OUTPUT_DIR],
  ['SAKUTTO_E2E_REAL=1', { SAKUTTO_E2E_REAL: '1' }, true, FIXTURE_OUTPUT_DIR],
  ['both flags', { SAKUTTO_FAKE_ENGINE: '1', SAKUTTO_E2E_REAL: '1' }, true, FIXTURE_OUTPUT_DIR],
  ['SAKUTTO_FAKE_ENGINE=0', { SAKUTTO_FAKE_ENGINE: '0' }, false, RELEASE_OUTPUT_DIR],
  ['SAKUTTO_E2E_REAL=0', { SAKUTTO_E2E_REAL: '0' }, false, RELEASE_OUTPUT_DIR],
];

describe('extension output directory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(BUILD_FLAG_MATRIX)('routes %s to one output directory', (_name, env, fixture, dir) => {
    expect(isFixtureBuild(env)).toBe(fixture);
    expect(extensionOutputDir(env)).toBe(dir);
  });

  it('reads the build flags from process.env when no environment is given', () => {
    vi.stubEnv('SAKUTTO_FAKE_ENGINE', undefined);
    vi.stubEnv('SAKUTTO_E2E_REAL', undefined);
    expect(isFixtureBuild()).toBe(false);
    expect(extensionOutputDir()).toBe(RELEASE_OUTPUT_DIR);

    vi.stubEnv('SAKUTTO_E2E_REAL', '1');
    expect(isFixtureBuild()).toBe(true);
    expect(extensionOutputDir()).toBe(FIXTURE_OUTPUT_DIR);
  });

  it('joins the Chromium package under the root for each build kind', () => {
    const root = resolve(sep, 'repo');
    expect(chromeExtensionDir(root, 'release')).toBe(`${root}${sep}.output${sep}chrome-mv3`);
    expect(chromeExtensionDir(root, 'fixture')).toBe(
      `${root}${sep}.output${sep}fixture${sep}chrome-mv3`,
    );
  });
});

/**
 * The config is the writer and `scripts/extension-output.ts` is what every reader goes
 * through, so the config has to take its `outDir` from the same helper. Re-importing the
 * config under each set of flags re-evaluates it, exactly as WXT does for every build.
 */
async function loadWxtConfig(flags: Record<string, string>): Promise<UserConfig> {
  vi.stubEnv('SAKUTTO_FAKE_ENGINE', flags.SAKUTTO_FAKE_ENGINE);
  vi.stubEnv('SAKUTTO_E2E_REAL', flags.SAKUTTO_E2E_REAL);
  vi.resetModules();
  const { default: config } = await import('../wxt.config.ts');
  return config;
}

function chromeManifest(config: UserConfig): Record<string, unknown> {
  const factory = config.manifest;
  if (typeof factory !== 'function') throw new Error('expected a manifest factory');
  return factory({
    browser: 'chrome',
    manifestVersion: 3,
    command: 'build',
    mode: 'production',
  } as never) as Record<string, unknown>;
}

function fakeEngineDefine(config: UserConfig): unknown {
  const vite = config.vite;
  if (typeof vite !== 'function') throw new Error('expected a vite config factory');
  const viteConfig = vite({ command: 'build', mode: 'production' } as never);
  return (viteConfig as { define?: Record<string, unknown> }).define?.__SAKUTTO_FAKE_ENGINE__;
}

const FIXTURE_HOSTS = ['http://127.0.0.1/*', 'http://localhost/*', 'https://x.com/*'];

describe('wxt.config output directory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('writes a release build to .output and asks for no host permissions', async () => {
    const config = await loadWxtConfig({});
    expect(config.outDir).toBe(RELEASE_OUTPUT_DIR);
    expect(chromeManifest(config).host_permissions).toEqual([]);
    expect(fakeEngineDefine(config)).toBe('false');
  });

  it.each([
    ['the fake engine', { SAKUTTO_FAKE_ENGINE: '1' }],
    ['the real engine', { SAKUTTO_E2E_REAL: '1' }],
  ])('writes an e2e fixture build with %s to .output/fixture', async (_name, flags) => {
    const config = await loadWxtConfig(flags);
    expect(config.outDir).toBe(FIXTURE_OUTPUT_DIR);
    expect(chromeManifest(config).host_permissions).toEqual(expect.arrayContaining(FIXTURE_HOSTS));
  });

  it('compiles the fake engine only into the SAKUTTO_FAKE_ENGINE build', async () => {
    expect(fakeEngineDefine(await loadWxtConfig({ SAKUTTO_FAKE_ENGINE: '1' }))).toBe('true');
    expect(fakeEngineDefine(await loadWxtConfig({ SAKUTTO_E2E_REAL: '1' }))).toBe('false');
  });
});
