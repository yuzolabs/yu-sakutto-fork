import { PAGE_SHORTCUT_DEDUP_MS, type SessionScope } from '@/dom/session';
import type { SiteAuto } from '@/dom/sites';
import { GrokUnlocker, type GrokUnlockerOptions } from './grok';
import { xBodyScope } from './locate';

/** What decides whether X post translation runs in this tab right now. */
export interface XBodyConditions {
  /** The reader's X post translation setting. */
  settingOn: boolean;
  /** The x.com site rule; `never` stops the feature entirely. */
  auto: SiteAuto;
  /**
   * True when Sakutto can translate what a "Show original" press reveals: the license is
   * accepted and the model (or the local server) is usable. A downloaded model that is not
   * loaded yet counts, because it loads on demand.
   */
  ready: boolean;
}

/** The part of the page session the controller drives. */
export interface XBodySession {
  isActive(): boolean;
  translate(): Promise<void>;
  restore(): void;
  setScope(scope: SessionScope | null): void;
  setBarAlwaysShown(shown: boolean): void;
  rescan(): void;
}

export interface XBodyControllerOptions {
  /** True only on an `https://x.com/` page in the Chrome build. */
  eligible: boolean;
  /** Called when the tab enters or leaves X post translation, to swap the bar wording. */
  onModeChange?: (on: boolean) => void;
  /** Called right before a translation starts, to warm the engine. */
  onStart?: () => void;
  /** Overrides for the unlocker, for tests. */
  unlocker?: Partial<GrokUnlockerOptions>;
  /** Clock for the duplicate-command guard, for tests. */
  now?: () => number;
}

/**
 * Runs X post translation in one x.com tab.
 *
 * While the setting is on and the site rule is not `never`, the page session is limited to
 * X text and starts on its own once Sakutto can translate. The popup's page button and the
 * bar's restore control then stop and resume it for this tab only; a reload starts it again.
 * Grok translations keep being turned off while it is stopped, so pressing resume finds the
 * originals already in place. Turning the setting off, or a `never` rule, stops both at once
 * and puts Sakutto's translations back; originals X already shows stay as they are.
 */
export class XBodyController {
  private on = false;
  private paused = false;
  private ready = false;
  private lastToggleAt = Number.NEGATIVE_INFINITY;
  private readonly unlocker: GrokUnlocker;

  constructor(
    doc: Document,
    private readonly session: XBodySession,
    private readonly options: XBodyControllerOptions,
  ) {
    this.unlocker = new GrokUnlocker(doc, {
      canUnlock: () => this.on && this.ready,
      // A press swaps text in place; ask for a scan so the original is picked up even when
      // the change lands in the same batch as one of the session's own paints.
      onUnlock: () => session.rescan(),
      ...options.unlocker,
    });
  }

  /** True while X post translation owns this tab, whether translating or stopped. */
  get active(): boolean {
    return this.on;
  }

  /** True after the reader stopped X post translation in this tab. */
  get stopped(): boolean {
    return this.on && this.paused;
  }

  /** Item IDs whose Grok translation was turned off in this tab. */
  unlockedIds(): ReadonlySet<string> {
    return this.unlocker.pressedIds();
  }

  update(conditions: XBodyConditions): void {
    const on = this.options.eligible && conditions.settingOn && conditions.auto !== 'never';
    this.ready = conditions.ready;
    if (on !== this.on) {
      this.on = on;
      if (on) {
        this.paused = false;
        this.session.setScope(xBodyScope());
      } else {
        this.unlocker.stop();
        // Leaving the scope puts every Sakutto translation back.
        this.session.setScope(null);
      }
      this.session.setBarAlwaysShown(!on);
      this.options.onModeChange?.(on);
    }
    if (!on) return;
    if (this.ready) {
      if (this.unlocker.running) this.unlocker.sweep();
      else this.unlocker.start();
    } else {
      this.unlocker.stop();
    }
    void this.startIfDue();
  }

  /** Stops X post translation in this tab and shows the source text again. */
  stop(): void {
    if (!this.on) return;
    this.paused = true;
    this.session.restore();
  }

  /** Starts X post translation again after `stop`. */
  async resume(): Promise<void> {
    if (!this.on) return;
    this.paused = false;
    await this.startIfDue();
  }

  /** The popup's page button, the page command, and the shortcut while this tab is on. */
  async toggle(command: 'toggle' | 'restore'): Promise<void> {
    if (command === 'toggle') {
      // The same guard as the page session's: a shortcut delivered twice would otherwise stop
      // and resume at once, which looks like it did nothing.
      const now = this.options.now?.() ?? Date.now();
      if (now - this.lastToggleAt < PAGE_SHORTCUT_DEDUP_MS) return;
      this.lastToggleAt = now;
    }
    if (command === 'restore' || this.session.isActive()) {
      this.stop();
      return;
    }
    await this.resume();
  }

  /**
   * The display toggle starts a stopped page in the other display mode, so it counts as a
   * resume rather than leaving the tab marked as stopped.
   */
  noteStarted(): void {
    if (this.on) this.paused = false;
  }

  dispose(): void {
    this.unlocker.stop();
  }

  private async startIfDue(): Promise<void> {
    if (!this.on || this.paused || !this.ready || this.session.isActive()) return;
    this.options.onStart?.();
    await this.session.translate();
  }
}
