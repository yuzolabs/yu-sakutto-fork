import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendSelection } from '@/engine/in-browser/backend';
import type { LlamaRuntime } from '@/engine/in-browser/runtime';
import type { ModelId } from '@/engine/model/catalog';
import { EngineHost, type EngineServices } from '@/engine/offscreen/host';
import type { TranslateOptions } from '@/engine/types';
import type { WllamaCompletionParams } from '@/engine/wllama/module';
import { EMPTY_GPU_DIAGNOSTIC } from '@/shared/gpu-diagnostic';
import { collectChunks } from './support/fakes';

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
}

type CompletionStep = (params: WllamaCompletionParams) => Promise<void>;

const native = vi.hoisted(() => ({
  instances: [] as FakeWllamaInstance[],
  /** One entry per upcoming completion, in order. With none left, a completion answers normally. */
  steps: [] as CompletionStep[],
}));

vi.mock('@/engine/wllama', () => ({
  createWllama: vi.fn(async () => {
    const instance: FakeWllamaInstance = { params: {}, exited: false };
    native.instances.push(instance);
    return {
      loadModel: vi.fn(async (_blobs: Blob[], params: Record<string, unknown>) => {
        instance.params = params;
      }),
      createCompletion: vi.fn(async (params: WllamaCompletionParams) => {
        const step = native.steps.shift();
        if (step) {
          await step(params);
          return;
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
    /** Keeps one loaded runtime per selection, like the real manager, with no file checks. */
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
        if (this.loaded && this.loaded.id === id && sameShape(this.loaded.selection, selection)) {
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
});
