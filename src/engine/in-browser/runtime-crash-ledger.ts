/** Entries kept in each set, so a long session that never resets does not grow without bound. */
const MAX_LEDGER_ENTRIES = 256;

/**
 * Remembers which pieces were running when the translation runtime crashed, so a piece that
 * keeps crashing it fails alone instead of being sent again and reloading the runtime each time.
 *
 * A crash fails every request on the runtime, so it does not say which piece caused it. Every
 * piece that was running becomes a suspect, and a suspect runs alone on the next runtime, with no
 * other completion beside it. When the runtime crashes again while a suspect runs alone, that
 * piece caused it: it becomes a culprit and is not sent again. A suspect that finishes is cleared.
 */
export class RuntimeCrashLedger {
  private readonly suspects = new Set<string>();
  private readonly culprits = new Set<string>();

  /** The piece crashed the runtime while it ran alone; sending it again would crash it again. */
  isCulprit(key: string): boolean {
    return this.culprits.has(key);
  }

  /** The piece was running when the runtime crashed and has not finished since. */
  isSuspect(key: string): boolean {
    return this.suspects.has(key);
  }

  /** Notes a crash the piece was running in. `alone` says no other completion ran beside it. */
  noteCrash(key: string, alone: boolean): void {
    if (alone) {
      this.suspects.delete(key);
      remember(this.culprits, key);
      return;
    }
    remember(this.suspects, key);
  }

  /** The piece finished, so it did not cause the crash it was running in. */
  noteFinished(key: string): void {
    this.suspects.delete(key);
  }

  clear(): void {
    this.suspects.clear();
    this.culprits.clear();
  }
}

function remember(entries: Set<string>, key: string): void {
  entries.delete(key);
  entries.add(key);
  while (entries.size > MAX_LEDGER_ENTRIES) {
    const oldest = entries.values().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}
