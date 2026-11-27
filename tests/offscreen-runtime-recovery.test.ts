import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendSelection } from '@/engine/in-browser/backend';
import type { LlamaRuntime } from '@/engine/in-browser/runtime';
import type { ModelId } from '@/engine/model/catalog';
import { EngineHost, type EngineServices } from '@/engine/offscreen/host';
import type { TranslateOptions } from '@/engine/types';
import type { WllamaCompletionParams } from '@/engine/wllama/module';
import { EMPTY_GPU_DIAGNOSTIC } from '@/shared/gpu-diagnostic';
import { collectChunks } from './support/fakes';
import { deferred } from './support/ports';

/**
 * The offscreen host's own `createServices`, wired to the real runtime, lazy engine and
 * in-browser engine. Only the browser surfaces under them are replaced: the capability probe,
 * OPFS, the model file checks and the wllama module itself.
 */

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'test-extension' } },
}));

interface FakeWllamaInstance {
  params: Record<string, unknown>;
  exited: boolean;
  completions: number;
  /** Set by a crash step: every later completion on this worker never answers. */
  wedged: boolean;
}

type CompletionStep = (
  params: WllamaCompletionParams,
  instance: FakeWllamaInstance,
) => Promise<void>;

const native = vi.hoisted(() => ({
  instances: [] as FakeWllamaInstance[],
  /** One entry per upcoming completion, in order. With none left, a completion answers normally. */
  steps: [] as CompletionStep[],
  /** A prompt this matches crashes the worker every time, like a paragraph that trips a bug. */
  crashOn: null as ((prompt: string) => boolean) | null,
}));

vi.mock('@/engine/wllama', () => ({
  createWllama: vi.fn(async () => {
    const instance: FakeWllamaInstance = {
      params: {},
      exited: false,
      completions: 0,
      wedged: false,
    };
    native.instances.push(instance);
    return {
      loadModel: vi.fn(async (_blobs: Blob[], params: Record<string, unknown>) => {
        instance.params = params;
      }),
      createCompletion: vi.fn(async (params: WllamaCompletionParams) => {
        instance.completions += 1;
        if (instance.wedged) return new Promise<void>(() => undefined);
        const step = native.steps.shift();
        if (step) {
          await step(params, instance);
          return;
        }
        if (native.crashOn?.(params.prompt)) {
          instance.wedged = true;
          const error = new Error('Invalid typed array length: 1163217991');
          error.name = 'RuntimeError';
          throw error;
        }
        params.onData?.({ choices: [{ text: 'こんにちは', finish_reason: 'stop' }] });
      }),
      exit: vi.fn(async () => {
        instance.exited = true;
      }),
    };
  }),
}));

vi.mock('@/shared/capabilities', () => ({
  probeCapabilities: vi.fn(async () => ({
    crossOriginIsolated: true,
    webgpu: 'ready',
    hardwareConcurrency: 24,
    gpuFastBatches: true,
  })),
  lastGpuDiagnostic: vi.fn(() => ({ ...EMPTY_GPU_DIAGNOSTIC, vendor: 'nvidia' })),
  lastWebGpuAdapterInfo: vi.fn(() => null),
  isHardWebGpuFailure: vi.fn(() => false),
  resetCapabilityProbe: vi.fn(),
}));

vi.mock('@/engine/model/file-store', () => ({
  OpfsModelFileStore: { open: vi.fn(async () => ({})) },
}));

vi.mock('@/engine/model/folder-session', () => ({
  SharedFolderSession: class {
    async apply(): Promise<void> {}
    status(): undefined {
      return undefined;
    }
    async refreshPermissionSnapshot(): Promise<undefined> {
      return undefined;
    }
  },
}));

vi.mock('@/engine/model/manager', () => {
  interface Loaded {
    id: ModelId;
    runtime: LlamaRuntime;
    selection: BackendSelection;
  }
  const sameShape = (a: BackendSelection, b: BackendSelection): boolean =>
    a.backend === b.backend &&
    a.nThreads === b.nThreads &&
    a.nGpuLayers === b.nGpuLayers &&
    a.nParallel === b.nParallel &&
    a.nCtx === b.nCtx;
  return {
    /**
     * Keeps one loaded runtime per selection and loads again when it stopped, like the real
     * manager, with no file checks.
     */
    ModelManager: class {
      private loaded: Loaded | null = null;

      constructor(
        private readonly options: {
          createRuntime: (blob: Blob, selection: BackendSelection) => Promise<LlamaRuntime>;
        },
      ) {}

      get loadedModel(): Loaded | null {
        return this.loaded;
      }

      async ensureLoaded(id: ModelId, selection: BackendSelection): Promise<Loaded> {
        if (
          this.loaded &&
          this.loaded.id === id &&
          this.loaded.runtime.stopped !== true &&
          sameShape(this.loaded.selection, selection)
        ) {
          return this.loaded;
        }
        await this.unload();
        const runtime = await this.options.createRuntime(new Blob(), selection);
        this.loaded = { id, runtime, selection };
        return this.loaded;
      }

      async unload(): Promise<void> {
        const current = this.loaded;
        this.loaded = null;
        await current?.runtime.dispose().catch(() => undefined);
      }

      async status(id: ModelId) {
        return { id, state: 'ready', received: 1, total: 1, progress: 1 };
      }

      setStores(): void {}

      async hasReadableCopy(): Promise<boolean> {
        return true;
      }

      async modelBlob(): Promise<Blob> {
        return new Blob();
      }
    },
  };
});

function options(): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal: new AbortController().signal };
}

/** wllama's `WllamaRuntimeError`: every request the worker was running rejects with it. */
function runtimeError(message: string): Error {
  const error = new Error(message);
  error.name = 'RuntimeError';
  return error;
}

function failNextCompletion(error: unknown): void {
  native.steps.push(async () => {
    throw error;
  });
}

/** A JS exception escaped the worker: the request fails and the worker stops answering. */
function crashNextCompletion(error: unknown, after: Promise<unknown> = Promise.resolve()): void {
  native.steps.push(async (_params, instance) => {
    await after;
    instance.wedged = true;
    throw error;
  });
}

/** The worker exception that used to move the reported X article from WebGPU to the CPU. */
function workerException(): Error {
  return runtimeError('Invalid typed array length: 1163217991');
}

async function openServices(): Promise<{ host: EngineHost; services: EngineServices }> {
  const host = new EngineHost({ idleReleaseMs: 60_000 });
  const services = await (host as unknown as { services(): Promise<EngineServices> }).services();
  return { host, services };
}

async function translateHello(services: EngineServices): Promise<string | undefined> {
  const chunks = await collectChunks(
    services.lazy.translate([{ id: 'a', text: 'Hello.' }], options()),
  );
  return chunks.at(-1)?.final;
}

function loadedSlots(): number[] {
  return native.instances.map((instance) => Number(instance.params['n_parallel']));
}

const WASM_ABORT = '(ABORT) Aborted()';

beforeEach(() => {
  native.instances.length = 0;
  native.steps.length = 0;
  native.crashOn = null;
});

describe('offscreen host after a lost GPU', () => {
  it('steps down when the GPU is lost again soon after', async () => {
    const { services } = await openServices();

    failNextCompletion(runtimeError(WASM_ABORT));
    await expect(translateHello(services)).resolves.toBe('こんにちは');
    failNextCompletion(runtimeError(WASM_ABORT));
    await expect(translateHello(services)).resolves.toBe('こんにちは');

    expect(loadedSlots()).toEqual([16, 16, 4]);
    expect(services.selection).toMatchObject({ backend: 'webgpu', nParallel: 4 });
  });

  it('reloads the chosen tier as it is after the tier is set again', async () => {
    const { services } = await openServices();

    failNextCompletion(runtimeError(WASM_ABORT));
    await expect(translateHello(services)).resolves.toBe('こんにちは');
    await services.setTier('auto');
    failNextCompletion(runtimeError(WASM_ABORT));
    await expect(translateHello(services)).resolves.toBe('こんにちは');

    expect(loadedSlots()).toEqual([16, 16, 16, 16]);
    expect(services.selection).toMatchObject({ backend: 'webgpu', nParallel: 16 });
  });

  it('keeps the text the runtime failed with when the GPU losses end on the CPU', async () => {
    const { host, services } = await openServices();

    failNextCompletion(runtimeError(WASM_ABORT));
    failNextCompletion(runtimeError(WASM_ABORT));
    failNextCompletion(runtimeError(WASM_ABORT));
    await expect(translateHello(services)).resolves.toBe('こんにちは');
    expect((await host.status()).gpuDiagnostic?.error).toBeNull();
    failNextCompletion(runtimeError('(ABORT) Aborted(device lost)'));
    await expect(translateHello(services)).resolves.toBe('こんにちは');

    expect(loadedSlots()).toEqual([16, 16, 4, 1, 1]);
    expect(native.instances.at(-1)?.params['n_gpu_layers']).toBe(0);
    const status = await host.status();
    expect(status).toMatchObject({
      backend: 'cpu-wasm',
      gpuFallback: true,
      gpuFallbackReason: 'device',
    });
    expect(status.gpuDiagnostic?.error).toContain('(ABORT) Aborted(device lost)');
    expect(status.gpuDiagnostic?.vendor).toBe('nvidia');
  });

  it('counts a JS exception that names a lost device as a lost GPU', async () => {
    const { services } = await openServices();
    const deviceLost = "Failed to execute 'mapAsync' on 'GPUBuffer': Device is lost";

    failNextCompletion(runtimeError(deviceLost));
    await expect(translateHello(services)).resolves.toBe('こんにちは');
    failNextCompletion(runtimeError(deviceLost));
    await expect(translateHello(services)).resolves.toBe('こんにちは');

    expect(loadedSlots()).toEqual([16, 16, 4]);
  });
});

describe('offscreen host after the runtime crashed', () => {
  it('restarts a crashed WebGPU runtime on the same slots', async () => {
    const { host, services } = await openServices();

    crashNextCompletion(workerException());
    await expect(translateHello(services)).resolves.toBe('こんにちは');
    crashNextCompletion(workerException());
    await expect(translateHello(services)).resolves.toBe('こんにちは');

    expect(loadedSlots()).toEqual([16, 16, 16]);
    expect(native.instances.slice(0, 2).every((instance) => instance.exited)).toBe(true);
    const status = await host.status();
    expect(status).toMatchObject({ backend: 'webgpu', parallel: 16, gpuFallback: false });
    expect(status.gpuFallbackReason).toBeUndefined();
    expect(status.gpuDiagnostic?.error).toBeNull();
  });

  it('does not count a crash toward stepping down after a lost GPU', async () => {
    const { services } = await openServices();

    crashNextCompletion(workerException());
    await expect(translateHello(services)).resolves.toBe('こんにちは');
    failNextCompletion(runtimeError(WASM_ABORT));
    await expect(translateHello(services)).resolves.toBe('こんにちは');

    expect(loadedSlots()).toEqual([16, 16, 16]);
  });

  it('restarts a crashed CPU runtime and finishes the waiting request', async () => {
    const { host, services } = await openServices();
    await services.setTier('c8');
    crashNextCompletion(workerException());

    // One CPU slot: the second request waits for the first, which crashes the worker. The
    // stopped worker would never answer it.
    const translations = await Promise.all([
      translateHello(services),
      collectChunks(services.lazy.translate([{ id: 'b', text: 'Bye.' }], options())),
    ]);

    expect(translations[0]).toBe('こんにちは');
    expect(translations[1].at(-1)).toMatchObject({ id: 'b', final: 'こんにちは' });
    expect(native.instances.map((instance) => instance.params['n_gpu_layers'])).toEqual([0, 0]);
    expect(native.instances[0]?.exited).toBe(true);
    expect(await host.status()).toMatchObject({ backend: 'cpu-wasm', gpuFallback: false });
  });

  it('ends every request that was running on the crashed runtime', async () => {
    const { services } = await openServices();
    const started = deferred<void>();
    // The first request starts streaming and then never hears back from the worker; the
    // second one crashes it.
    native.steps.push(async (params) => {
      params.onData?.({ choices: [{ text: 'こ' }] });
      started.resolve();
      await new Promise<never>(() => undefined);
    });
    crashNextCompletion(workerException(), started.promise);

    const [first, second] = await Promise.all([
      translateHello(services),
      collectChunks(services.lazy.translate([{ id: 'b', text: 'Bye.' }], options())),
    ]);

    expect(first).toBe('こんにちは');
    expect(second.at(-1)).toMatchObject({ id: 'b', final: 'こんにちは' });
    expect(loadedSlots()).toEqual([16, 16]);
  });
});

describe('offscreen host with a paragraph that keeps crashing the runtime', () => {
  const poison = { id: 'p', text: 'A POISON paragraph.' };

  it('leaves that paragraph untranslated and stays on WebGPU', async () => {
    const { host, services } = await openServices();
    native.crashOn = (prompt) => prompt.includes('POISON');

    const [hello, poisoned, bye] = await Promise.all([
      translateHello(services),
      collectChunks(services.lazy.translate([poison], options())),
      collectChunks(services.lazy.translate([{ id: 'b', text: 'Bye.' }], options())),
    ]);

    expect(hello).toBe('こんにちは');
    expect(bye.at(-1)).toMatchObject({ id: 'b', final: 'こんにちは' });
    expect(poisoned.at(-1)).toEqual({ id: 'p', final: poison.text, engine: 'plamo', error: true });
    // Once with whatever else was running, once alone; then the paragraph is not sent again.
    expect(loadedSlots()).toEqual([16, 16, 16]);
    const status = await host.status();
    expect(status).toMatchObject({ backend: 'webgpu', parallel: 16, gpuFallback: false });

    const completions = native.instances.at(-1)?.completions;
    const again = await collectChunks(services.lazy.translate([poison], options()));
    expect(again.at(-1)).toMatchObject({ id: 'p', error: true });
    expect(loadedSlots()).toEqual([16, 16, 16]);
    expect(native.instances.at(-1)?.completions).toBe(completions);
  });
});
