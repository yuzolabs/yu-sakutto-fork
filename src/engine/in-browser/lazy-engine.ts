import { abortError, isEngineError } from '../errors';
import { DEGENERATE_SESSION_BLOCKS } from '../text/degenerate';
import type {
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import type { BackendSelection } from './backend';
import { InBrowserEngine, type InBrowserEngineOptions } from './engine';
import type { LlamaRuntime } from './runtime';

export interface LoadedRuntime {
  runtime: LlamaRuntime;
  selection: BackendSelection;
}

export interface LazyInBrowserEngineOptions {
  loadRuntime: (signal: AbortSignal) => Promise<LoadedRuntime>;
  /**
   * CPU runtime for one broken WebGPU piece. The GPU session stays up until
   * several distinct pieces fail, or until warm-up already left WebGPU.
   */
  loadRetryRuntime?: (signal: AbortSignal) => Promise<LlamaRuntime | null>;
  /**
   * Runs once before the next load. `lost` reloads the same selection the first
   * time. `degenerate` leaves WebGPU after several distinct collapsed pieces.
   * `error` is the `gpu-lost` error of the request that saw the loss first.
   */
  onGpuLost?: (reason: 'lost' | 'degenerate', error?: unknown) => Promise<void>;
  /**
   * Runs once before the next load after the runtime stopped without losing the GPU device,
   * such as a JS exception inside the wllama worker. The host drops the stopped runtime and
   * keeps the selection: a runtime crash does not count as a lost GPU.
   */
  onRuntimeCrash?: (error: unknown) => Promise<void>;
  config?: InBrowserEngineOptions['config'];
}

/** Enough to walk reload, four slots, CPU, even if every step loses the GPU again. */
const MAX_GPU_RECOVERIES = 3;
/** Runtime crash restarts one translate call waits through before it hands the error back. */
const MAX_RUNTIME_RESTARTS = 3;

export class LazyInBrowserEngine implements IdentifiedEngine {
  readonly kind = 'plamo' as const;

  private engine: InBrowserEngine | null = null;
  private engineTask: Promise<InBrowserEngine> | null = null;
  private loadController: AbortController | null = null;
  private generation = 0;
  private waiting = 0;
  private recovery: Promise<void> | null = null;
  private degenerateBlocks = 0;
  private needSessionFallback = false;

  constructor(private readonly options: LazyInBrowserEngineOptions) {}

  /** Drops the engine after the runtime is released so the next request loads a fresh one. */
  reset(): void {
    this.dropEngine();
    this.degenerateBlocks = 0;
    this.needSessionFallback = false;
  }

  private dropEngine(): void {
    this.generation += 1;
    this.loadController?.abort();
    this.loadController = null;
    this.engine = null;
    this.engineTask = null;
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    let pending = segments;
    const streamed = new Set<string>();

    let gpuRecoveries = 0;
    let runtimeRestarts = 0;
    for (;;) {
      const engine = await this.getEngine(options);
      const restarting = new Set(streamed);
      try {
        for await (const chunk of engine.translate(pending, options)) {
          if (chunk.final !== undefined) {
            pending = pending.filter((segment) => segment.id !== chunk.id);
          } else if (restarting.delete(chunk.id)) {
            yield { ...chunk, restart: true };
            continue;
          } else {
            streamed.add(chunk.id);
          }
          yield chunk;
        }
        if (this.needSessionFallback) await this.recover(engine, 'degenerate');
        return;
      } catch (error) {
        if (options.signal.aborted || !isEngineError(error)) throw error;
        if (error.code === 'gpu-lost' && gpuRecoveries < MAX_GPU_RECOVERIES) {
          gpuRecoveries += 1;
          await this.recover(engine, 'lost', error);
        } else if (error.code === 'runtime-crashed' && runtimeRestarts < MAX_RUNTIME_RESTARTS) {
          runtimeRestarts += 1;
          await this.restartRuntime(engine, error);
        } else {
          throw error;
        }
        if (pending.length === 0) return;
      }
    }
  }

  /**
   * Every request on a crashed runtime lands here; only the first one drops its engine and asks
   * the host to release it. The next load then starts a new runtime on the same selection.
   */
  private restartRuntime(crashed: InBrowserEngine, error: unknown): Promise<void> {
    const onRuntimeCrash = this.options.onRuntimeCrash;
    if (this.engine === crashed) {
      this.dropEngine();
      if (onRuntimeCrash) {
        this.recovery = onRuntimeCrash(error).finally(() => {
          this.recovery = null;
        });
      }
    }
    return this.recovery ?? Promise.resolve();
  }

  /** Every request running on the lost GPU lands here; only the first one does the work. */
  private recover(
    lost: InBrowserEngine,
    reason: 'lost' | 'degenerate',
    error?: unknown,
  ): Promise<void> {
    const onGpuLost = this.options.onGpuLost;
    if (this.engine === lost && onGpuLost) {
      this.reset();
      const leaving = error === undefined ? onGpuLost(reason) : onGpuLost(reason, error);
      this.recovery = leaving.finally(() => {
        this.recovery = null;
      });
    }
    return this.recovery ?? Promise.resolve();
  }

  private getEngine(options: TranslateOptions): Promise<InBrowserEngine> {
    if (this.engine) return Promise.resolve(this.engine);

    if (!this.engineTask) {
      const generation = this.generation;
      const controller = new AbortController();
      this.loadController = controller;

      const task = this.createEngine(controller.signal)
        .then((engine) => {
          if (this.generation === generation) this.engine = engine;
          return engine;
        })
        .finally(() => {
          if (this.engineTask === task) this.engineTask = null;
          if (this.loadController === controller) this.loadController = null;
        });

      this.engineTask = task;
    }

    return this.waitFor(this.engineTask, options.signal);
  }

  /**
   * Races the shared load against the caller's signal so one caller giving up does not tear
   * down a load that later callers still need.
   */
  private async waitFor(
    task: Promise<InBrowserEngine>,
    signal: AbortSignal,
  ): Promise<InBrowserEngine> {
    if (signal.aborted) throw abortError();

    this.waiting += 1;
    try {
      return await new Promise<InBrowserEngine>((resolve, reject) => {
        const onAbort = (): void => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });

        task.then(
          (engine) => {
            signal.removeEventListener('abort', onAbort);
            resolve(engine);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    } finally {
      this.waiting -= 1;
      if (this.waiting === 0 && this.engineTask) this.loadController?.abort();
    }
  }

  private async createEngine(signal: AbortSignal): Promise<InBrowserEngine> {
    await this.recovery;
    const loaded = await this.options.loadRuntime(signal);

    return new InBrowserEngine(loaded.runtime, {
      contextTokens: Math.floor(loaded.selection.nCtx / Math.max(1, loaded.selection.nParallel)),
      ...(this.options.config ? { config: this.options.config } : {}),
      ...(this.options.loadRetryRuntime ? { loadRetryRuntime: this.options.loadRetryRuntime } : {}),
      onDegenerateBlock: () => {
        this.degenerateBlocks += 1;
        if (this.degenerateBlocks >= DEGENERATE_SESSION_BLOCKS) this.needSessionFallback = true;
      },
    });
  }
}
