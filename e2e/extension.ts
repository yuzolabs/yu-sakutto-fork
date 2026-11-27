import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { chromeExtensionDir } from '../scripts/extension-output.ts';

// The e2e package `pnpm test:e2e` builds. Never `.output/chrome-mv3`: that is the release
// build a browser may have loaded as an unpacked extension.
const extensionPath = chromeExtensionDir(process.cwd(), 'fixture');

const ALLOWED_REQUEST = [
  /^chrome-extension:/,
  /^chrome:/,
  /^devtools:/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?\//,
  /^http:\/\/localhost(?::\d+)?\//,
  /^https:\/\/huggingface\.co\//,
  /^https:\/\/cdn-lfs\.huggingface\.co\//,
  /^https:\/\/(?:[a-z0-9-]+\.)*hf\.co\//,
  /^https:\/\/mail\.google\.com\//,
  /^https:\/\/outlook\.(?:live|office|office365)\.com\//,
  /^https:\/\/outlook\.cloud\.microsoft\//,
  /^data:/,
  /^blob:/,
  /^about:/,
];

export interface LoadedExtension {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  denied: string[];
  close: () => Promise<void>;
}

export function isAllowedRequest(url: string): boolean {
  return ALLOWED_REQUEST.some((pattern) => pattern.test(url));
}

export async function loadExtension(lang: 'en-US' | 'ja'): Promise<LoadedExtension> {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'sakutto-profile-'));
  return launchExtension(lang, profileDirectory, true);
}

/** Opens the built extension in an existing profile. `close` leaves the profile on disk. */
export async function launchExtension(
  lang: 'en-US' | 'ja',
  profileDirectory: string,
  deleteProfile = false,
): Promise<LoadedExtension> {
  // Checked here, not at module load: `tests/extension-network.test.ts` imports this file
  // under Vitest, where no e2e package has been built.
  if (!existsSync(join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `No e2e extension at ${extensionPath}. Run "pnpm test:e2e" first; it builds the test package there.`,
    );
  }

  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--lang=${lang === 'ja' ? 'ja' : 'en-US'}`,
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--disable-default-apps',
  ];
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    ...(lang === 'en-US' ? { locale: 'en-US' } : {}),
    args,
  });

  const denied: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isAllowedRequest(url)) return route.continue();
    if (!denied.includes(url)) denied.push(url);
    return route.abort();
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context
      .waitForEvent('serviceworker', { timeout: 30_000 })
      .catch(async (error: unknown) => {
        await context.close();
        if (deleteProfile) await rm(profileDirectory, { recursive: true, force: true });
        throw error;
      }));

  return {
    context,
    extensionId: new URL(worker.url()).host,
    worker,
    denied,
    close: async () => {
      await context.close();
      if (deleteProfile) await rm(profileDirectory, { recursive: true, force: true });
    },
  };
}
