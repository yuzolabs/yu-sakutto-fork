import { resolve } from 'node:path';

/**
 * Where WXT writes the extension, and where the tools that load a build read it from.
 *
 * One WXT config builds two kinds of package. `pnpm build` is the release build. The e2e
 * suite and the page benches build a *fixture*: `SAKUTTO_FAKE_ENGINE=1` swaps the model for
 * an in-page fake translator, and `SAKUTTO_E2E_REAL=1` keeps the real engine but adds
 * install-time host permissions for the local and mail fixtures. A fixture build used to land
 * in `.output/chrome-mv3` as well, over the release build. A browser that has that directory
 * loaded as an unpacked extension serves whatever is on disk to every new tab, so after a test
 * run real pages were translated by the fake engine (its `§ja§` markers showed up in posts) or
 * ran with permissions the release never asks for. The fixture builds therefore go to their own
 * directory, and both the config and every consumer of the fixture take that path from here so
 * the writer and the readers cannot drift apart.
 */

/** WXT `outDir` of a release build (`pnpm build`, `pnpm build:firefox`, `pnpm zip`). */
export const RELEASE_OUTPUT_DIR = '.output';

/** WXT `outDir` of an e2e or bench fixture build (`SAKUTTO_FAKE_ENGINE=1` or `SAKUTTO_E2E_REAL=1`). */
export const FIXTURE_OUTPUT_DIR = '.output/fixture';

/** Which kind of build a path refers to: the release package, or an e2e / bench fixture. */
export type ExtensionBuildKind = 'release' | 'fixture';

/** The environment variables that turn a build into a fixture build. */
export interface BuildEnv {
  SAKUTTO_FAKE_ENGINE?: string | undefined;
  SAKUTTO_E2E_REAL?: string | undefined;
}

/**
 * Whether the build running under `env` is an e2e or bench fixture build: the fake engine is
 * compiled in (`SAKUTTO_FAKE_ENGINE=1`) or the real engine gets the fixture host permissions
 * (`SAKUTTO_E2E_REAL=1`). The output directory and the manifest's `host_permissions` both
 * follow this one answer, so they can never disagree.
 */
export function isFixtureBuild(env: BuildEnv = process.env): boolean {
  return env.SAKUTTO_FAKE_ENGINE === '1' || env.SAKUTTO_E2E_REAL === '1';
}

/** The WXT `outDir` for the build running under `env`, relative to the repository root. */
export function extensionOutputDir(env: BuildEnv = process.env): string {
  return isFixtureBuild(env) ? FIXTURE_OUTPUT_DIR : RELEASE_OUTPUT_DIR;
}

/**
 * Absolute path of the Chromium MV3 package of one build kind under `root`: the release build
 * at `<root>/.output/chrome-mv3`, a fixture build at `<root>/.output/fixture/chrome-mv3`.
 */
export function chromeExtensionDir(root: string, kind: ExtensionBuildKind): string {
  return resolve(root, kind === 'fixture' ? FIXTURE_OUTPUT_DIR : RELEASE_OUTPUT_DIR, 'chrome-mv3');
}
