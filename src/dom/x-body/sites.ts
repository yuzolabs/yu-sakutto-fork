import { browser } from 'wxt/browser';
import { allSitesGrantCoversOrigins } from '@/dom/all-sites';
import { isFirefoxBuild } from '@/shared/browser';

/**
 * X post translation runs on exactly this host. `www.x.com` and `mobile.x.com` redirect to it,
 * and the `twitter.com` hosts are a different origin the reader never granted for this feature,
 * so none of them count.
 */
export const X_BODY_HOST = 'x.com';

/** The one optional origin requested when the reader turns X post translation on. */
export const X_BODY_ORIGIN = 'https://x.com/*';

function normalizedHost(host: string): string {
  return host.trim().replace(/\.$/u, '').toLowerCase();
}

/** True only for `x.com` itself. */
export function isXBodyHost(host: string): boolean {
  return normalizedHost(host) === X_BODY_HOST;
}

/** True for an `https://x.com/...` page. Any other scheme or host is out of scope. */
export function isXBodyPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && isXBodyHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function xBodyPermissionOrigins(): string[] {
  return [X_BODY_ORIGIN];
}

export function xBodyOriginsOverlap(origins: readonly string[] | undefined): boolean {
  if (!origins || origins.length === 0) return false;
  return origins.includes(X_BODY_ORIGIN);
}

/**
 * The feature exists only in the Chrome build. Firefox never shows the setting and never runs
 * it, even when an imported or synced settings record has it turned on.
 */
export function xBodySupported(): boolean {
  return !isFirefoxBuild();
}

/** Whether the background should make sure an open tab runs the content script. */
export function shouldAutoInjectXBody(options: {
  settingOn: boolean;
  url: string;
  originAllowed: boolean;
  supported?: boolean;
}): boolean {
  if (options.supported === false) return false;
  if (!options.settingOn || !options.originAllowed) return false;
  return isXBodyPageUrl(options.url);
}

/**
 * Optional host access for x.com. `permissions.request` must be the first awaited extension
 * call in the click that turns the setting on: an earlier `await` (`permissions.contains`
 * included) drops the user gesture and Chrome shows no prompt. A broad all-sites grant
 * already covers the origin and requesting it would still prompt, so the grant alone turns
 * the setting on and no request runs.
 */
export async function requestXBodyHostAccess(): Promise<boolean> {
  const origins = xBodyPermissionOrigins();
  if (allSitesGrantCoversOrigins(origins)) return true;
  return browser.permissions.request({ origins }).catch(() => false);
}

export interface XBodyToggleDecision {
  on: boolean;
  denied: boolean;
}

/**
 * Turns X post translation on only after the x.com origin is granted in this click; a denial
 * leaves it off so the checkbox can revert and show why.
 *
 * The checkbox lives on the options page only. Unlike the toolbar popup, that page stays
 * open while Chrome shows its permission prompt, so the result of the request always comes
 * back here and no enable intent has to be stored for a later settle step.
 */
export async function resolveXBodyToggle(
  nextOn: boolean,
  requestAccess: () => Promise<boolean> = requestXBodyHostAccess,
): Promise<XBodyToggleDecision> {
  if (!nextOn) return { on: false, denied: false };
  const granted = await requestAccess();
  if (!granted) return { on: false, denied: true };
  return { on: true, denied: false };
}
