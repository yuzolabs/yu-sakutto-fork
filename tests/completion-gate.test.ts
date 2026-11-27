import { describe, expect, it } from 'vitest';
import { CompletionGate, forwardCompletionToken } from '@/engine/in-browser/runtime';

describe('completion gate', () => {
  it('waits for the current completion before starting the next one', async () => {
    const gate = new CompletionGate();
    let release!: () => void;
    let started = false;
    const first = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = gate.exclusive(async () => {
      started = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(false);
    release();
    await first;
    await second;
    expect(started).toBe(true);
  });

  it('runs as many completions as the slot count', async () => {
    const gate = new CompletionGate(2);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let started = 0;
    const first = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          releaseFirst = resolve;
        }),
    );
    const second = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          releaseSecond = resolve;
        }),
    );
    const third = gate.exclusive(async () => {
      started += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(2);
    releaseFirst();
    releaseSecond();
    await first;
    await second;
    await third;
    expect(started).toBe(3);
  });

  it('opens the gate when the current completion fails', async () => {
    const gate = new CompletionGate();
    const order: string[] = [];
    const first = gate.exclusive(async () => {
      order.push('first');
      throw new Error('fail');
    });
    const second = gate.exclusive(async () => {
      order.push('second');
    });

    await expect(first).rejects.toThrow('fail');
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('runs a lone completion with nothing beside it', async () => {
    const gate = new CompletionGate(4);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let releaseAlone!: () => void;
    const first = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          order.push('first');
          releaseFirst = resolve;
        }),
    );
    const alone = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          order.push('alone');
          releaseAlone = resolve;
        }),
      true,
    );
    // Asks after the lone one, so it waits behind it although slots are free.
    const later = gate.exclusive(async () => {
      order.push('later');
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first']);
    releaseFirst();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first', 'alone']);
    releaseAlone();
    await alone;
    await later;
    expect(order).toEqual(['first', 'alone', 'later']);
  });

  it('starts the waiting completions together after a lone one', async () => {
    const gate = new CompletionGate(2);
    let releaseAlone!: () => void;
    const releases: Array<() => void> = [];
    let running = 0;
    const alone = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          releaseAlone = resolve;
        }),
      true,
    );
    const others = [1, 2, 3].map(() =>
      gate.exclusive(
        () =>
          new Promise<void>((resolve) => {
            running += 1;
            releases.push(resolve);
          }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running).toBe(0);
    releaseAlone();
    await alone;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running).toBe(2);
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running).toBe(3);
    for (const release of releases.splice(0)) release();
    await Promise.all(others);
  });

  it('opens the gate when a lone completion fails', async () => {
    const gate = new CompletionGate(2);
    const alone = gate.exclusive(async () => {
      throw new Error('fail');
    }, true);
    let ran = false;
    const next = gate.exclusive(async () => {
      ran = true;
    });

    await expect(alone).rejects.toThrow('fail');
    await next;
    expect(ran).toBe(true);
  });

  it('drops tokens that arrive after abort', () => {
    const seen: string[] = [];
    const accept = (text: string): void => {
      seen.push(text);
    };
    forwardCompletionToken(AbortSignal.abort(), 'late', accept);
    forwardCompletionToken(new AbortController().signal, '', accept);
    forwardCompletionToken(new AbortController().signal, 'ok', accept);
    expect(seen).toEqual(['ok']);
  });
});
