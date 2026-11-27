import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCheckout } from '../scripts/wllama/build';

const GIT_TEST_CONFIG = [
  'user.name=Sakutto test',
  'user.email=test@example.invalid',
  'commit.gpgsign=false',
  'core.hooksPath=',
  // the build's line ending settings, so a file it checks out is not seen as a local change
  'core.autocrlf=false',
  'core.eol=lf',
  'protocol.file.allow=always',
].flatMap((setting) => ['-c', setting]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_TEST_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const FILE_TRANSPORT_ENV = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
};

/** git refuses the file transport for a submodule unless it is allowed for the build's git calls. */
async function withFileTransport(action: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(FILE_TRANSPORT_ENV).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, FILE_TRANSPORT_ENV);
  try {
    await action();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('the wllama checkout', () => {
  let root = '';
  let wllamaOrigin = '';
  let wllamaCommit = '';
  let llamaCppPin = '';
  let llamaCppTip = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sakutto-wllama-checkout-'));

    // The default branch moves past the pin, so a checkout left on it is not at the pin.
    const llamaCppOrigin = join(root, 'llama.cpp');
    git(root, 'init', '-q', '-b', 'master', llamaCppOrigin);
    writeFileSync(join(llamaCppOrigin, 'pinned.txt'), 'pinned\n');
    git(llamaCppOrigin, 'add', 'pinned.txt');
    git(llamaCppOrigin, 'commit', '-q', '-m', 'Pinned commit');
    llamaCppPin = git(llamaCppOrigin, 'rev-parse', 'HEAD');
    git(llamaCppOrigin, 'rm', '-q', 'pinned.txt');
    writeFileSync(join(llamaCppOrigin, 'later.txt'), 'later\n');
    git(llamaCppOrigin, 'add', 'later.txt');
    git(llamaCppOrigin, 'commit', '-q', '-m', 'Later commit');
    llamaCppTip = git(llamaCppOrigin, 'rev-parse', 'HEAD');

    wllamaOrigin = join(root, 'wllama');
    git(root, 'init', '-q', '-b', 'master', wllamaOrigin);
    git(wllamaOrigin, 'submodule', '--quiet', 'add', '../llama.cpp', 'llama.cpp');
    git(join(wllamaOrigin, 'llama.cpp'), 'checkout', '-q', llamaCppPin);
    git(wllamaOrigin, 'add', '.gitmodules', 'llama.cpp');
    git(wllamaOrigin, 'commit', '-q', '-m', 'Pin llama.cpp');
    wllamaCommit = git(wllamaOrigin, 'rev-parse', 'HEAD');
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function cloneCheckout(name: string): string {
    const checkoutDir = join(root, name);
    git(root, 'clone', '-q', wllamaOrigin, checkoutDir);
    return checkoutDir;
  }

  async function ensurePinnedCheckout(checkoutDir: string): Promise<void> {
    await withFileTransport(() =>
      ensureCheckout({
        checkoutDir,
        repository: wllamaOrigin,
        wllamaCommit,
        llamaCppCommit: llamaCppPin,
      }),
    );
  }

  it('checks llama.cpp out again when a failed checkout left it on the default branch', async () => {
    const checkoutDir = cloneCheckout('failed-checkout');
    const llamaCppDir = join(checkoutDir, 'llama.cpp');
    git(checkoutDir, 'submodule', '--quiet', 'update', '--init');
    git(llamaCppDir, 'checkout', '-q', llamaCppTip);
    expect(existsSync(join(llamaCppDir, '.git'))).toBe(true);

    await ensurePinnedCheckout(checkoutDir);

    expect(git(llamaCppDir, 'rev-parse', 'HEAD')).toBe(llamaCppPin);
    expect(existsSync(join(llamaCppDir, 'pinned.txt'))).toBe(true);
  });

  it('initialises llama.cpp at the pin in a fresh clone', async () => {
    const checkoutDir = cloneCheckout('fresh-clone');
    const llamaCppDir = join(checkoutDir, 'llama.cpp');
    expect(existsSync(join(llamaCppDir, '.git'))).toBe(false);

    await ensurePinnedCheckout(checkoutDir);

    expect(git(llamaCppDir, 'rev-parse', 'HEAD')).toBe(llamaCppPin);
    expect(existsSync(join(llamaCppDir, 'pinned.txt'))).toBe(true);
  });
});
