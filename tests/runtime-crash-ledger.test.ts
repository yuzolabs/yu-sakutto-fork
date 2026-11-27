import { describe, expect, it } from 'vitest';
import { RuntimeCrashLedger } from '@/engine/in-browser/runtime-crash-ledger';

describe('runtime crash ledger', () => {
  it('suspects every piece that was running in a crash', () => {
    const ledger = new RuntimeCrashLedger();

    ledger.noteCrash('a', false);
    ledger.noteCrash('b', false);

    expect(ledger.isSuspect('a')).toBe(true);
    expect(ledger.isSuspect('b')).toBe(true);
    expect(ledger.isCulprit('a')).toBe(false);
  });

  it('blames a piece that crashed the runtime while it ran alone', () => {
    const ledger = new RuntimeCrashLedger();

    ledger.noteCrash('a', false);
    ledger.noteCrash('a', true);

    expect(ledger.isCulprit('a')).toBe(true);
    expect(ledger.isSuspect('a')).toBe(false);
  });

  it('clears a suspect that finished', () => {
    const ledger = new RuntimeCrashLedger();

    ledger.noteCrash('a', false);
    ledger.noteFinished('a');

    expect(ledger.isSuspect('a')).toBe(false);
    expect(ledger.isCulprit('a')).toBe(false);
  });

  it('forgets everything when cleared', () => {
    const ledger = new RuntimeCrashLedger();

    ledger.noteCrash('a', true);
    ledger.noteCrash('b', false);
    ledger.clear();

    expect(ledger.isCulprit('a')).toBe(false);
    expect(ledger.isSuspect('b')).toBe(false);
  });

  it('keeps only the most recent pieces', () => {
    const ledger = new RuntimeCrashLedger();

    for (let index = 0; index < 300; index += 1) ledger.noteCrash(`piece ${index}`, true);

    expect(ledger.isCulprit('piece 0')).toBe(false);
    expect(ledger.isCulprit('piece 299')).toBe(true);
  });
});
