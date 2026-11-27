import { describe, expect, it, vi } from 'vitest';
import { abortError, EngineError } from '@/engine/errors';
import type { BackendSelection } from '@/engine/in-browser/backend';
import { LazyInBrowserEngine } from '@/engine/in-browser/lazy-engine';
import {
  CompletionGate,
  type CompletionRequest,
  type CompletionResult,
  type LlamaRuntime,
} from '@/engine/in-browser/runtime';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { collectChunks, FakeRuntime } from './support/fakes';
import { deferred, flushTasks } from './support/ports';
import { promptSource } from './support/sim-runtime';

const SELECTION: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

function options(signal: AbortSignal = new AbortController().signal): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal };
}

describe('LazyInBrowserEngine', () => {
  it('keeps a shared load alive when the first caller aborts', async () => {
    const loaded = deferred<{ runtime: FakeRuntime; selection: BackendSelection }>();
    const loadRuntime = vi.fn(async (signal: AbortSignal) => {
      const result = await loaded.promise;
      if (signal.aborted) throw abortError();
      return result;
    });
    const engine = new LazyInBrowserEngine({ loadRuntime });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options(firstController.signal)),
    );
    await flushTasks();
    const second = collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options(secondController.signal)),
    );
    await flushTasks();

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'aborted' });

    loaded.resolve({ runtime: new FakeRuntime(() => 'こんにちは'), selection: SELECTION });

    await expect(second).resolves.toEqual([
      { id: 'a', textDelta: 'こ', engine: 'plamo' },
      { id: 'a', textDelta: 'ん', engine: 'plamo' },
      { id: 'a', textDelta: 'に', engine: 'plamo' },
      { id: 'a', textDelta: 'ち', engine: 'plamo' },
      { id: 'a', textDelta: 'は', engine: 'plamo' },
      { id: 'a', final: 'こんにちは', engine: 'plamo' },
    ]);
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it('aborts the shared load when every caller gives up', async () => {
    const loaded = deferred<{ runtime: FakeRuntime; selection: BackendSelection }>();
    let loadSignal: AbortSignal | undefined;
    const engine = new LazyInBrowserEngine({
      loadRuntime: async (signal) => {
        loadSignal = signal;
        return loaded.promise;
      },
    });

    const controller = new AbortController();
    const pending = collectChunks(
      engine.translate([{ id: 'a', text: 'Hello.' }], options(controller.signal)),
    );
    await flushTasks();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await flushTasks();
    expect(loadSignal?.aborted).toBe(true);
    loaded.resolve({ runtime: new FakeRuntime(() => 'x'), selection: SELECTION });
  });

  it('does not adopt a load that finishes after reset', async () => {
    const stale = deferred<{ runtime: FakeRuntime; selection: BackendSelection }>();
    const firstRuntime = new FakeRuntime(() => '古い');
    const secondRuntime = new FakeRuntime(() => '新しい');
    const loadRuntime = vi
      .fn()
      .mockImplementationOnce(async (signal: AbortSignal) => {
        const result = await stale.promise;
        if (signal.aborted) throw abortError();
        return result;
      })
      .mockImplementationOnce(async () => ({ runtime: secondRuntime, selection: SELECTION }));

    const engine = new LazyInBrowserEngine({ loadRuntime });
    const pending = collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));
    await flushTasks();

    engine.reset();
    stale.resolve({ runtime: firstRuntime, selection: SELECTION });
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });

    const chunks = await collectChunks(engine.translate([{ id: 'a', text: 'Hello.' }], options()));

    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(firstRuntime.requests).toHaveLength(0);
    expect(secondRuntime.requests).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ id: 'a', final: '新しい', engine: 'plamo' });
  });
});

describe('LazyInBrowserEngine after the GPU is lost', () => {
  const gone = () => new EngineError('gpu-lost', 'The GPU stopped working.');
  const a = { id: 'a', text: 'Hello.' };
  const b = { id: 'b', text: 'Bye.' };

  function dying(afterToken = false): FakeRuntime {
    const runtime = new FakeRuntime(() => '');
    runtime.complete = async (request) => {
      if (afterToken) request.onToken('壊');
      throw gone();
    };
    return runtime;
  }

  function engineOver(runtimes: FakeRuntime[], onGpuLost = vi.fn(async () => undefined)) {
    const loadRuntime = vi.fn(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error('nothing left to load');
      return { runtime, selection: SELECTION };
    });
    return { engine: new LazyInBrowserEngine({ loadRuntime, onGpuLost }), loadRuntime, onGpuLost };
  }

  it('reloads and finishes the request', async () => {
    const { engine, loadRuntime, onGpuLost } = engineOver([dying(), new FakeRuntime(() => 'は')]);

    await expect(collectChunks(engine.translate([a], options()))).resolves.toEqual([
      { id: 'a', textDelta: 'は', engine: 'plamo' },
      { id: 'a', final: 'は', engine: 'plamo' },
    ]);
    expect(onGpuLost).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('hands the host the error the GPU was lost with', async () => {
    const { engine, onGpuLost } = engineOver([dying(), new FakeRuntime(() => 'は')]);

    await collectChunks(engine.translate([a], options()));

    expect(onGpuLost).toHaveBeenCalledWith('lost', expect.objectContaining({ code: 'gpu-lost' }));
  });

  it('starts over the text already streamed from the lost runtime', async () => {
    const { engine } = engineOver([dying(true), new FakeRuntime(() => 'はい')]);

    await expect(collectChunks(engine.translate([a], options()))).resolves.toEqual([
      { id: 'a', textDelta: '壊', engine: 'plamo' },
      { id: 'a', textDelta: 'は', engine: 'plamo', restart: true },
      { id: 'a', textDelta: 'い', engine: 'plamo' },
      { id: 'a', final: 'はい', engine: 'plamo' },
    ]);
  });

  it('recovers once for every request on the lost runtime', async () => {
    const { engine, loadRuntime, onGpuLost } = engineOver([dying(), new FakeRuntime(() => 'は')]);

    await Promise.all([
      collectChunks(engine.translate([a], options())),
      collectChunks(engine.translate([b], options())),
    ]);

    expect(onGpuLost).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('does not translate again what already finished', async () => {
    // Long enough that the two texts are not packed into one request.
    const first_ = { id: 'a', text: 'A sentence of ordinary length. '.repeat(12) };
    const next = { id: 'b', text: 'Another ordinary sentence here. '.repeat(12) };
    const second = new FakeRuntime(() => 'は');
    let calls = 0;
    const first = new FakeRuntime(() => '');
    first.complete = async (request) => {
      calls += 1;
      if (calls > 1) throw gone();
      request.onToken('先');
    };
    const { engine } = engineOver([first, second]);

    const chunks = await collectChunks(engine.translate([first_, next], options()));

    expect(chunks.filter((chunk) => chunk.final !== undefined)).toHaveLength(2);
    expect(second.requests).toHaveLength(1);
  });

  it('gives up after walking every step', async () => {
    const { engine, loadRuntime } = engineOver([dying(), dying(), dying(), dying()]);

    await expect(collectChunks(engine.translate([a], options()))).rejects.toMatchObject({
      code: 'gpu-lost',
    });
    expect(loadRuntime).toHaveBeenCalledTimes(4);
  });

  it('retries a collapsed WebGPU piece on CPU without leaving the session', async () => {
    const bad = new FakeRuntime(() => ',3'.repeat(200), 1, 'webgpu');
    bad.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは');
    const onGpuLost = vi.fn(async () => undefined);
    const loadRuntime = vi.fn(async () => ({ runtime: bad, selection: SELECTION }));
    const engine = new LazyInBrowserEngine({
      loadRuntime,
      loadRetryRuntime: async () => cpu,
      onGpuLost,
    });

    const chunks = await collectChunks(engine.translate([a], options()));

    expect(chunks.some((chunk) => chunk.restart === true)).toBe(true);
    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'こんにちは', engine: 'plamo' });
    expect(onGpuLost).not.toHaveBeenCalled();
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it('does not leave a collapsed CPU piece untranslated', async () => {
    const bad = new FakeRuntime(() => ',3'.repeat(200));
    bad.fillBudget = true;
    const { engine, onGpuLost, loadRuntime } = engineOver([bad]);

    const chunks = await collectChunks(engine.translate([a], options()));
    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'Hello.', engine: 'plamo', error: true });
    expect(onGpuLost).not.toHaveBeenCalled();
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it('does not walk the lost-GPU steps for a crashed runtime', async () => {
    const crashing = new FakeRuntime(() => '');
    crashing.complete = async () => {
      throw new EngineError('runtime-crashed', 'The translation runtime stopped.');
    };
    const onRuntimeCrash = vi.fn(async () => undefined);
    const runtimes = [crashing, new FakeRuntime(() => 'は')];
    const loadRuntime = vi.fn(async () => ({ runtime: runtimes.shift()!, selection: SELECTION }));
    const onGpuLost = vi.fn(async () => undefined);
    const engine = new LazyInBrowserEngine({ loadRuntime, onGpuLost, onRuntimeCrash });

    await expect(collectChunks(engine.translate([a], options()))).resolves.toEqual([
      { id: 'a', textDelta: 'は', engine: 'plamo' },
      { id: 'a', final: 'は', engine: 'plamo' },
    ]);
    expect(onRuntimeCrash).toHaveBeenCalledOnce();
    expect(onRuntimeCrash).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'runtime-crashed' }),
    );
    expect(onGpuLost).not.toHaveBeenCalled();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('leaves any other failure to the caller', async () => {
    const broken = new FakeRuntime(() => '');
    broken.complete = async () => {
      throw new EngineError('model-load-failed', 'refused');
    };
    const { engine, onGpuLost } = engineOver([broken]);

    await expect(collectChunks(engine.translate([a], options()))).rejects.toMatchObject({
      code: 'model-load-failed',
    });
    expect(onGpuLost).not.toHaveBeenCalled();
  });

  it('does not leave WebGPU again after reset', async () => {
    const gpu = new FakeRuntime(
      (prompt) => {
        const source = promptSource(prompt);
        return source.startsWith('Bad') ? ',3'.repeat(200) : `訳:${source}`;
      },
      1,
      'webgpu',
    );
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは');
    const onGpuLost = vi.fn(async () => undefined);
    const engine = new LazyInBrowserEngine({
      loadRuntime: async () => ({ runtime: gpu, selection: SELECTION }),
      loadRetryRuntime: async () => cpu,
      onGpuLost,
      config: { maxSegmentTokens: 1 },
    });

    await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'Bad sentence about the harbour lights one.' },
          { id: 'b', text: 'Bad sentence about the harbour lights two.' },
          { id: 'c', text: 'Bad sentence about the harbour lights three.' },
        ],
        options(),
      ),
    );
    expect(onGpuLost).toHaveBeenCalledOnce();
    expect(onGpuLost).toHaveBeenCalledWith('degenerate');

    onGpuLost.mockClear();
    const afterReset = await collectChunks(
      engine.translate([{ id: 'ok', text: 'Hello.' }], options()),
    );
    expect(afterReset.at(-1)?.final).toBe('訳:Hello.');
    expect(onGpuLost).not.toHaveBeenCalled();
  });

  it('starts the collapsed-block count over after an explicit model-switch reset', async () => {
    const gpu = new FakeRuntime(() => ',3'.repeat(200), 1, 'webgpu');
    gpu.fillBudget = true;
    const cpu = new FakeRuntime(() => 'こんにちは');
    const onGpuLost = vi.fn(async () => undefined);
    const engine = new LazyInBrowserEngine({
      loadRuntime: async () => ({ runtime: gpu, selection: SELECTION }),
      loadRetryRuntime: async () => cpu,
      onGpuLost,
      config: { maxSegmentTokens: 1 },
    });

    await collectChunks(
      engine.translate(
        [
          { id: 'a', text: 'One sentence about the harbour lights.' },
          { id: 'b', text: 'Another sentence about the harbour lights.' },
        ],
        options(),
      ),
    );
    expect(onGpuLost).not.toHaveBeenCalled();

    engine.reset();
    await collectChunks(
      engine.translate(
        [{ id: 'c', text: 'A third sentence about the harbour lights.' }],
        options(),
      ),
    );
    expect(onGpuLost).not.toHaveBeenCalled();
  });
});

describe('LazyInBrowserEngine after the runtime crashed', () => {
  const crashed = () => new EngineError('runtime-crashed', 'The translation runtime stopped.');
  const a = { id: 'a', text: 'Hello.' };
  const b = { id: 'b', text: 'Bye.' };

  function crashing(): FakeRuntime {
    const runtime = new FakeRuntime(() => '');
    runtime.complete = async () => {
      throw crashed();
    };
    return runtime;
  }

  function engineOver(runtimes: FakeRuntime[], withHost = true) {
    const loadRuntime = vi.fn(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error('nothing left to load');
      return { runtime, selection: SELECTION };
    });
    const onRuntimeCrash = vi.fn(async () => undefined);
    const engine = new LazyInBrowserEngine({
      loadRuntime,
      ...(withHost ? { onRuntimeCrash } : {}),
    });
    return { engine, loadRuntime, onRuntimeCrash };
  }

  it('loads a new runtime and finishes the request', async () => {
    const { engine, loadRuntime } = engineOver([crashing(), new FakeRuntime(() => 'は')]);

    const chunks = await collectChunks(engine.translate([a], options()));

    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'は', engine: 'plamo' });
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('loads a new runtime even when no host listens for the crash', async () => {
    const { engine, loadRuntime } = engineOver([crashing(), new FakeRuntime(() => 'は')], false);

    const chunks = await collectChunks(engine.translate([a], options()));

    expect(chunks.at(-1)).toEqual({ id: 'a', final: 'は', engine: 'plamo' });
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('restarts once for every request on the crashed runtime', async () => {
    const { engine, loadRuntime, onRuntimeCrash } = engineOver([
      crashing(),
      new FakeRuntime(() => 'は'),
    ]);

    const [first, second] = await Promise.all([
      collectChunks(engine.translate([a], options())),
      collectChunks(engine.translate([b], options())),
    ]);

    expect(first.at(-1)).toEqual({ id: 'a', final: 'は', engine: 'plamo' });
    expect(second.at(-1)).toEqual({ id: 'b', final: 'は', engine: 'plamo' });
    expect(onRuntimeCrash).toHaveBeenCalledOnce();
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it('hands the crash back after a few restarts', async () => {
    const { engine, loadRuntime } = engineOver([crashing(), crashing(), crashing(), crashing()]);

    await expect(collectChunks(engine.translate([a], options()))).rejects.toMatchObject({
      code: 'runtime-crashed',
    });
    expect(loadRuntime).toHaveBeenCalledTimes(4);
  });
});

/**
 * Several slots behind the real completion gate. A piece that `crashes` matches stops the worker
 * while it runs, and every request running at that moment fails with it, as wllama rejects every
 * task after `signal.abort`. Other pieces take a little longer, so some are still running then.
 */
class CrashingRuntime implements LlamaRuntime {
  readonly backend = 'webgpu' as const;
  readonly threads = 8;
  stopped = false;
  readonly started: Array<{ source: string; alone: boolean }> = [];
  private readonly gate: CompletionGate;
  private readonly running = new Set<(error: unknown) => void>();

  constructor(
    readonly parallel: number,
    private readonly crashes: (source: string) => boolean,
  ) {
    this.gate = new CompletionGate(parallel);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    await this.gate.exclusive(async () => {
      if (this.stopped) throw crashedRuntime();
      request.onStart?.();
      const source = promptSource(request.prompt);
      this.started.push({ source, alone: request.alone === true });
      const crash = this.crashes(source);
      await new Promise<void>((resolve, reject) => {
        this.running.add(reject);
        setTimeout(
          () => {
            this.running.delete(reject);
            if (this.stopped) return;
            if (!crash) {
              request.onToken(`訳:${source}`);
              resolve();
              return;
            }
            this.stopped = true;
            for (const other of this.running) other(crashedRuntime());
            this.running.clear();
            reject(crashedRuntime());
          },
          crash ? 1 : 5,
        );
      });
    }, request.alone === true);
    return { hitMaxTokens: false };
  }

  async dispose(): Promise<void> {
    this.stopped = true;
  }
}

function crashedRuntime(): EngineError {
  return new EngineError('runtime-crashed', 'The translation runtime stopped.');
}

describe('LazyInBrowserEngine with a piece that crashes the runtime', () => {
  const poison = { id: 'p', text: 'A poison sentence about the harbour lights.' };
  const others = [
    { id: 'a', text: 'A sentence about the harbour lights.' },
    { id: 'b', text: 'Another sentence about the harbour lights.' },
    { id: 'c', text: 'A third sentence about the harbour lights.' },
  ];

  function engineWithPoison() {
    const runtimes: CrashingRuntime[] = [];
    const loadRuntime = vi.fn(async () => {
      const runtime = new CrashingRuntime(4, (source) => source.includes('poison'));
      runtimes.push(runtime);
      return { runtime, selection: SELECTION };
    });
    // One segment per request, so the poison sentence is not packed with the others.
    const engine = new LazyInBrowserEngine({ loadRuntime, config: { maxSegmentTokens: 1 } });
    const poisonRuns = () =>
      runtimes.flatMap((runtime) => runtime.started).filter((run) => run.source.includes('poison'));
    return { engine, loadRuntime, runtimes, poisonRuns };
  }

  function finals(chunks: readonly TranslationChunk[]): Map<string, TranslationChunk> {
    return new Map(
      chunks.filter((chunk) => chunk.final !== undefined).map((chunk) => [chunk.id, chunk]),
    );
  }

  it('fails only that piece and translates the pieces that crashed with it', async () => {
    const { engine, loadRuntime, runtimes, poisonRuns } = engineWithPoison();

    const result = finals(
      await collectChunks(
        engine.translate([others[0]!, poison, others[1]!, others[2]!], options()),
      ),
    );

    expect(result.get('p')).toEqual({ id: 'p', final: poison.text, engine: 'plamo', error: true });
    for (const segment of others) {
      expect(result.get(segment.id)).toEqual({
        id: segment.id,
        final: `訳:${segment.text}`,
        engine: 'plamo',
      });
    }
    // Sent with the others once, then alone once; the third runtime never sees it.
    expect(poisonRuns().map((run) => run.alone)).toEqual([false, true]);
    expect(loadRuntime).toHaveBeenCalledTimes(3);
    expect(runtimes[2]?.started.some((run) => run.source.includes('poison'))).toBe(false);
    // Pieces waiting to run alone when the poison crashed the second runtime never started
    // there, and they still finished on the third.
    expect(runtimes[1]?.started.at(-1)).toMatchObject({ alone: true });
    expect(runtimes[1]?.started.at(-1)?.source).toContain('poison');
  });

  it('does not send that piece again or reload for it', async () => {
    const { engine, loadRuntime, poisonRuns } = engineWithPoison();
    await collectChunks(engine.translate([poison, others[0]!], options()));
    const loads = loadRuntime.mock.calls.length;
    const runs = poisonRuns().length;

    const again = await collectChunks(engine.translate([poison], options()));

    expect(again.at(-1)).toEqual({ id: 'p', final: poison.text, engine: 'plamo', error: true });
    expect(loadRuntime).toHaveBeenCalledTimes(loads);
    expect(poisonRuns()).toHaveLength(runs);
  });

  it('gives that piece another try after a reset', async () => {
    const { engine, poisonRuns } = engineWithPoison();
    await collectChunks(engine.translate([poison], options()));
    const runs = poisonRuns().length;

    engine.reset();
    const again = await collectChunks(engine.translate([poison], options()));

    expect(again.at(-1)).toMatchObject({ id: 'p', error: true });
    expect(poisonRuns().length).toBeGreaterThan(runs);
  });
});
