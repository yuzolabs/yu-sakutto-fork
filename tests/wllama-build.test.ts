import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  renderModuleScript,
  renderPthreadScript,
  renderWorkerScript,
} from '../scripts/wllama/artifacts';
import { assertWave64ProbePlacement } from '../scripts/wllama/webgpu-patch';

const GLUE =
  'var Module=typeof Module!="undefined"?Module:{};var ENVIRONMENT_IS_PTHREAD=false;var mainScriptUrlOrBlob="/wllama-pthread.js";';

const WORKER_CODE = [
  '// const getWModuleConfig',
  '// mainScriptUrlOrBlob',
  "// verb === 'module.init'",
  'globalThis.__result = RUN_OPTIONS;',
].join('\n');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

describe('wllama artifact rendering', () => {
  it('boots the worker from the run options in its url', () => {
    const source = renderWorkerScript(WORKER_CODE);

    expect(source).toContain("searchParams.get('options')");
    expect(source).toContain('importScripts(RUN_OPTIONS.moduleUrl)');
    expect(source).toContain('RUN_OPTIONS.noWebGPU');
    expect(source).toContain('sakuttoInstallFirefoxWebGpuKick');
    expect(source).toContain('var enabled = true');
    expect(source).toContain('RUN_OPTIONS.webgpuDebug');
    expect(source).toContain('__SAKUTTO_WEBGPU_DEBUG__');
    expect(source.replace(/\r\n/g, '\n').trimEnd().endsWith(WORKER_CODE.trimEnd())).toBe(true);
  });

  it('round-trips extension urls through the worker query string', () => {
    const options = {
      pathConfig: {
        'wllama.wasm': `${EXTENSION_ORIGIN}/vendor/wllama/wllama.wasm`,
      },
      nbThread: 0,
      compat: false,
      noWebGPU: true,
      moduleUrl: `${EXTENSION_ORIGIN}/vendor/wllama/wllama-module.js`,
    };
    const workerUrl = `${EXTENSION_ORIGIN}/vendor/wllama/wllama-worker.js?options=${encodeURIComponent(JSON.stringify(options))}`;

    const sandbox: Record<string, unknown> = {
      self: { location: { href: workerUrl } },
      URL,
      importScripts: () => undefined,
      WorkerNavigator: class {},
    };
    runInNewContext(renderWorkerScript(WORKER_CODE), sandbox);

    expect(sandbox.__result).toBeDefined();
    expect(JSON.parse(JSON.stringify(sandbox.__result))).toEqual(options);
  });

  it('refuses worker code that no longer matches the bootstrap', () => {
    expect(() => renderWorkerScript('onmessage = () => {};')).toThrow(/review the static worker/);
  });

  it('wraps the glue in a module initializer after the JSPI stub', () => {
    const source = renderModuleScript(GLUE, 'JSPI module');
    const stubIndex = source.indexOf('WebAssembly.Suspending');
    const glueIndex = source.indexOf('var ___Module');
    const returnIndex = source.lastIndexOf('return Module;');

    expect(source.startsWith('// SPDX-License-Identifier: MIT')).toBe(true);
    expect(source).toContain('function wModuleInit() {');
    expect(source).not.toContain('var Module=');
    expect(stubIndex).toBeGreaterThan(-1);
    expect(glueIndex).toBeGreaterThan(stubIndex);
    expect(returnIndex).toBeGreaterThan(glueIndex);
  });

  it('refuses glue without a single Module declaration', () => {
    expect(() => renderModuleScript('var x = 1;', 'module')).toThrow(/"var Module" 0 times/);
    expect(() => renderModuleScript(`${GLUE} var Module = {};`, 'module')).toThrow(
      /"var Module" 2 times/,
    );
  });

  it('keeps the pthread entry as a plain script', () => {
    const source = renderPthreadScript(GLUE, 'JSPI pthread entry');

    expect(source).toContain(GLUE);
    expect(source).toContain('WebAssembly.Suspending');
    expect(source).not.toContain('wModuleInit');
  });

  it('keeps subgroups on WebGPU limit retries and re-derives them from the device', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0007-webgpu-adapter-device-retry.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain('capped-limits optional-features');
    expect(patch).toContain('ggml_webgpu_apply_granted_device_caps');
    expect(patch).toContain('device.HasFeature(wgpu::FeatureName::Subgroups)');
    expect(patch).toContain('reject-max-limits');
    expect(patch).toContain('correctness probe');
    expect(patch).toContain('Never guess a size');
    expect(patch).not.toContain('capped-limits shader-f16');
    expect(patch).not.toContain('subgroup-64');
    expect(patch).not.toContain('min_sg = 32');
    expect(patch).not.toContain('max_sg = 64');
  });

  it('turns vec flash-attn off for a subgroup wider than 32 and checks an f16 matmul', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0009-webgpu-wave64-flash-attn.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain('caps.flash_attn_vec');
    expect(patch).toContain('subgroup_size > 32u');
    expect(patch).toContain('ggml_webgpu_probe_f16_matmul_wgsl');
    expect(patch).toContain('GGML_WEBGPU_PROBE_F16_MATMUL = 10');
    expect(patch).toContain('subgroupShuffleDown');
    expect(patch).toContain('tile attention needs');
    expect(patch).toContain('not a claim that a Radeon was retested');
    expect(patch).toContain('+    caps.subgroup_size            = 0;\n+}');
  });

  it('accepts the applied 0009 brace shape and rejects a stray extra closer', () => {
    const valid = `
void ggml_webgpu_disable_subgroups(webgpu_context ctx) {
    caps.max_subgroup_size        = 0;
    caps.flash_attn_vec           = false;
    caps.subgroup_size            = 0;
}

static const char * ggml_webgpu_probe_f16_sum_wgsl() {
    return "";
}

static const char * ggml_webgpu_probe_shuffle_down_wgsl() {
    return "";
}

bool ggml_webgpu_correctness_probe(webgpu_context ctx) {
    return true;
}
`;
    expect(() => assertWave64ProbePlacement(valid)).not.toThrow();

    const extraCloser = valid.replace(
      'caps.subgroup_size            = 0;\n}',
      'caps.subgroup_size            = 0;\n}\n}',
    );
    expect(() => assertWave64ProbePlacement(extraCloser)).toThrow(/extra closing brace/);
  });

  it('shrinks the mat-vec workgroup only for NVIDIA Q4_K and Q6_K with subgroups', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0010-webgpu-mat-vec-workgroup.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain(
      'if (key.use_mmvq && context.supports_subgroups && context.vendor == "nvidia" &&',
    );
    expect(patch).toContain('key.src0_type == GGML_TYPE_Q4_K || key.src0_type == GGML_TYPE_Q6_K');
    expect(patch).toContain('std::min<uint32_t>(key.wg_size, (threads + sg - 1) / sg * sg)');
    expect(patch).toContain('wg_size == other.wg_size');
    expect(patch).toContain('ggml_webgpu_hash_combine(seed, key.wg_size);');
    expect(patch).toContain('variant += "_wg" + std::to_string(wg_size);');
    expect(patch).not.toContain('mul_mat_vec.wgsl');
  });

  it('scans for the largest logit only when the sampler chain can return nothing else', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0011-greedy-sample-scan.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain('if (common_sampler_takes_max(gsmpl, ctx)) {');
    expect(patch).toContain(
      'gsmpl->grmr || gsmpl->rbudget || params.backend_sampling || params.mirostat != 0 || params.n_probs != 0',
    );
    expect(patch).toContain('!params.logit_bias.empty()');
    expect(patch).toContain('if (n_suppress > 0) {');
    expect(patch).toContain(
      'last == COMMON_SAMPLER_TYPE_TEMPERATURE && params.temp == 0.0f && params.dynatemp_range == 0.0f',
    );
    expect(patch).toContain('if (params.temp > 0.0f || params.dynatemp_range != 0.0f) {');
    expect(patch).toContain(
      '(params.penalty_repeat != 1.0f || params.penalty_freq != 0.0f || params.penalty_present != 0.0f)) {',
    );
    expect(patch).toContain('if (params.dry_multiplier != 0.0f) {');
    expect(patch).toContain('if (params.typ_p < 1.0f) {');
    expect(patch).toContain('if (params.xtc_probability > 0.0f) {');
    expect(patch).toContain('+            default:\n+                return false;');
    expect(patch).toContain('if (logits[token_id] > max_logit) {');
  });

  it('reads back the chosen tokens only when every sampling slot takes the largest logit', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0012-backend-argmax.patch', import.meta.url),
      'utf8',
    );
    // the server asks for it per decode, and not at all with a draft model
    expect(patch).toContain('llama_set_argmax_only(ctx_tgt, slots_take_max());');
    expect(patch).toContain('+        if (spec) {\n+            return false;');
    expect(patch).toContain(
      '!slot.task || !slot.task->need_sampling() || !slot.smpl ||\n+                !common_sampler_takes_max(slot.smpl.get(), ctx_tgt)',
    );
    // the graph gets the node only for an output layer that is not on the CPU
    expect(patch).toContain(
      'ggml_backend_dev_type(model.dev_output()) != GGML_BACKEND_DEVICE_TYPE_CPU',
    );
    expect(patch).toContain('res->t_argmax = ggml_argmax(res->get_ctx(), res->get_logits());');
    // a graph built for the other setting is not reused
    expect(patch).toContain(
      '+    argmax_only = value;\n+    // the graph gains or loses the argmax node, so the previous one cannot be reused\n+    gf_res_prev_active = nullptr;',
    );
    // the read replaces the logits only while the setting is on
    expect(patch).toContain(
      '+        if (argmax_only && res->t_argmax != nullptr && n_outputs > 0) {',
    );
    expect(patch).toContain(
      '+        } else if (logits.data && t_logits && n_outputs > 0 && needs_raw_logits(ubatch, sampling.samplers)) {',
    );
    // a decode or an encode must not leave the answer of the one before it readable
    expect(patch).toContain(
      '+void llama_context::argmax_forget() {\n+    if (argmax_valid) {\n+        // a read into argmax_out that is still in flight lands before the buffer is used again\n+        synchronize();\n+        argmax_valid = false;',
    );
    expect(patch).toContain(
      ' int llama_context::encode(const llama_batch_ext & batch_inp) {\n+    argmax_forget();',
    );
    expect(patch).toContain('         return encode(batch_inp);\n     }\n \n+    argmax_forget();');
    expect(patch).toContain('+    if (!argmax_valid) {\n+        return LLAMA_TOKEN_NULL;');
    // a row without logits is refused, not served from an earlier decode
    expect(patch).toContain(
      'if (argmax_valid && (size_t) j < argmax_out.size() && argmax_out[j] != LLAMA_TOKEN_NULL) {',
    );
    expect(patch).toContain('std::swap(argmax_out[i0], argmax_out[i1]);');
    expect(patch).toContain(
      '+        const llama_token found = llama_get_argmax_ith(ctx, idx);\n+        if (found != LLAMA_TOKEN_NULL) {',
    );
    // the shader keeps the lowest index of equal values and never reports -1
    expect(patch).toContain('+            if (val > local_pair.value) {');
    expect(patch).toContain('+        if (src[row_idx + col] > local_pair.value) {');
    expect(patch).toContain(
      'b.value == a.value && b.index >= 0 && (a.index < 0 || b.index < a.index)',
    );
    expect(patch).toContain('dst[params.offset_dst + wid.x] = max(shared_max[0].index, 0);');
  });

  it('returns a waiting result without running the server loop', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0013-get-result-pending-first.patch', import.meta.url),
      'utf8',
    );
    expect(patch).toContain(
      '+    auto next = get_next_result(rd);\n+    if (!next.first && rd.has_next())\n+    {\n+      run_loop();\n+      next = get_next_result(rd);\n+    }',
    );
    expect(patch).toContain(
      '-    run_loop();\n-    auto [result, is_error] = get_next_result(rd);',
    );
  });

  it('skips a KV tile only when every row of the workgroup has masked it with -inf', () => {
    const patch = readFileSync(
      new URL(
        '../scripts/wllama/patches/0014-webgpu-flash-attn-skip-masked-tiles.patch',
        import.meta.url,
      ),
      'utf8',
    );
    // only -inf counts as masked, a finite mask value can still reach the sums
    expect(patch).toContain('if (bitcast<u32>(f32(mask[mask_idx])) != 0xff800000u) {');
    // one flag per query row, written by one lane and read by all after a barrier
    expect(patch).toContain('+var<workgroup> row_live: array<u32, Q_TILE>;');
    expect(patch).toContain(
      '+        if (sg_inv_id == 0u && subgroup_id < Q_TILE) {\n+            row_live[subgroup_id] = select(0u, 1u, live_row);\n+        }\n+\n+        workgroupBarrier();',
    );
    // staging is skipped for the whole tile, the sums for a row
    expect(patch).toContain(
      '+        if (live_tile) {\n+            load_k_tile_block(local_id.x, kv_count, kv_tile, k_head_offset);',
    );
    expect(patch).toContain(
      '+        if (live_tile) {\n+            load_v_tile_block(local_id.x, kv_count, kv_tile, v_head_offset);',
    );
    expect(patch).toContain(
      '-            if (row_active && kv_local < kv_count) {\n+            if (live_row && kv_local < kv_count) {',
    );
    // without a mask nothing is skipped
    expect(patch).toContain('+        let live_row = row_active;\n+        let live_tile = true;');
    // the barriers and the subgroup reductions stay outside the new conditions
    expect(patch).not.toMatch(/^[+-].*(subgroupAdd|tile_max|tile_sum)/m);
    expect(patch.match(/^\+\s+workgroupBarrier\(\);$/gm)).toHaveLength(1);
  });

  it('keeps the v1.3.0-safe kernels on AMD/ATI adapters only', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0015-webgpu-wave64-vendor-gate.patch', import.meta.url),
      'utf8',
    );
    // the gate reads the adapter vendor and architecture through ggml_webgpu_adapter_is_amd()
    expect(patch).toContain('ggml_webgpu_adapter_is_amd(ctx->webgpu_global_ctx->vendor');
    expect(patch).toContain('caps.flash_attn_vec        = false;');
    expect(patch).toContain('caps.wide_subgroup_shuffle = false;');
    // it runs in the device probe, before any vec dispatch decision, and the log keeps vec=
    expect(patch).toContain('vec flash-attn off (wave64), tile shader only');
    expect(patch).toContain('ok vendor=%s subgroups=%s subgroup_size=%u');
    expect(patch).toContain('wide_shuffle=%s vec=%s');
    // the 0009 width gate stays, so every non-AMD vendor keeps vec when its probe allows it
    expect(patch).not.toContain('-        if (subgroup_size > 32u');
    // the gate is AMD-only: no other vendor is named in a condition
    expect(patch).not.toContain('!= "nvidia"');
    expect(patch).not.toContain('== "nvidia"');
    // no probe kernel and no shader edit: everyone outside AMD pays one string compare
    const addedLines = patch.split('\n').filter((line) => line.startsWith('+'));
    expect(addedLines.some((line) => line.includes('static const char * ggml_webgpu_probe'))).toBe(
      false,
    );
    expect(patch).not.toContain('.wgsl');
    // the 0012 argmax node is off AMD only; AMD keeps the logits readback
    expect(patch).toContain(
      'GGML_BACKEND_API bool ggml_backend_webgpu_dev_is_amd(ggml_backend_dev_t dev);',
    );
    expect(patch).toContain('bool ggml_backend_webgpu_dev_is_amd(ggml_backend_dev_t dev) {');
    expect(patch).toContain('!ggml_backend_webgpu_dev_is_amd(model.dev_output())');
  });

  it('keeps the masked-tile skip off AMD only', () => {
    const patch = readFileSync(
      new URL(
        '../scripts/wllama/patches/0016-webgpu-masked-tile-skip-vendor-gate.patch',
        import.meta.url,
      ),
      'utf8',
    );
    // the skip needs its own define, and the pipeline adds it for every adapter except AMD
    expect(patch).toContain('#if defined(MASK) && defined(SKIP_MASKED_TILES)');
    expect(patch).toContain('!ggml_webgpu_adapter_is_amd(context.vendor, context.architecture)');
    expect(patch).toContain('defines.push_back("SKIP_MASKED_TILES");');
    expect(patch).toContain('variant += "_skipmt";');
    // without the define the shader compiles the pre-skip flow: every tile staged and scored,
    // and a row bounded only by its own row_active, the decode of the shipped 1.3.0 build
    expect(patch).toContain('the decode of the shipped 1.3.0 build');
    // the 0014 mask scoring stays: the gate removes the skip only, never the mask read
    expect(patch).not.toMatch(/^[+-].*(local_scores[slot] = FLOAT_MIN)/m);
    // the gate sits in the tile branch, so the vec and subgroup-matrix paths are untouched
    expect(patch).toContain('defines.push_back("MAX_SUBGROUP_SIZE="');
    expect(patch).not.toContain('wgsl_flash_attn_vec');
    expect(patch).not.toContain('use_sg_matrix');
  });

  it('serializes a result with an invalid UTF-8 byte replaced instead of thrown', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0017-get-result-safe-utf8.patch', import.meta.url),
      'utf8',
    );
    // the serializer the llama.cpp HTTP server uses for the same results: U+FFFD per bad byte
    expect(patch).toContain(
      '+    res.data_json.value = result ? safe_json_to_str(data_json) : "";',
    );
    expect(patch).toContain('-    res.data_json.value = result ? data_json.dump() : "";');
    // it is the one line of get_result that leaves the result; the polling change above it stays
    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    expect(patch).not.toContain('run_loop()');
    expect(patch).not.toContain('get_next_result');
  });

  it('answers a failed action with an error and fails only the call that made it', () => {
    const patch = readFileSync(
      new URL('../scripts/wllama/patches/0018-failed-action-error-response.patch', import.meta.url),
      'utf8',
    );
    // the native side answers with the glue error event, not a null pointer without a length
    expect(patch).toContain('+      glue_msg_error err;');
    expect(patch).toContain('+      err.message.value = e.what();');
    expect(patch).toContain('+      err.handler.serialize(output_buffer);');
    expect(patch).toContain('+      output_len[0] = output_buffer.data.size();');
    expect(patch).toContain('-    return nullptr;');
    // the null pointer is kept only for an error that cannot be serialized
    expect(patch).toContain('+    catch (std::exception &)\n+    {\n+      return nullptr;');
    // the main thread turns that event into a typed error, which is not a dead runtime
    expect(patch).toContain("import { WllamaError, WllamaRuntimeError } from './wllama';");
    expect(patch).toContain("+    if (parsedResult._name === 'erro_evt') {");
    expect(patch).toContain(
      "+      throw new WllamaError(parsedResult.message, 'inference_error');",
    );
    // the worker reads no length from the request once the pointer is null
    expect(patch).toContain('+    if (!Number(outputPtr)) {');
    expect(patch).toContain('+        err: `Action "${argAction}" failed, see the native log`,');
    const nullCheck = patch.indexOf('+    if (!Number(outputPtr)) {');
    const readLength = patch.indexOf('const outputLen = new Uint32Array(', nullCheck);
    expect(readLength).toBeGreaterThan(nullCheck);
    // an action failure is not a worker abort: the catch that signals abort is untouched
    expect(patch).not.toMatch(/^[+-].*(handleError|signal\.abort)/m);
  });
});

/**
 * The worker's call queue and action runner, as the pinned source has them before the 0018
 * patch. The patch's hunk is applied to this text with git, and both versions are then run
 * against a fake wasm so the difference is seen in what the worker posts, not in the diff.
 */
const WORKER_CALL_QUEUE = `
// re-entering the wasm while a call is suspended (JSPI / asyncify) corrupts its state, so only one call runs at a time and the rest wait in the queue
let wasmCallBusy = false;
const wasmCallQueue = [];

const runWasmCall = async (callbackId, fn) => {
  if (isAborted) {
    // the wasm is dead, fail fast instead of calling into it
    msg({ callbackId, err: 'wllama has crashed, please reload the module' });
    return;
  }
  if (wasmCallBusy) {
    wasmCallQueue.push({ callbackId, fn });
    return;
  }
  wasmCallBusy = true;
  try {
    await fn();
  } finally {
    wasmCallBusy = false;
    if (isAborted) {
      // do not touch the wasm again after it aborted; the main thread already rejected the queued tasks
      wasmCallQueue.length = 0;
    } else {
      const next = wasmCallQueue.shift();
      if (next) runWasmCall(next.callbackId, next.fn);
    }
  }
};

const runAction = async (data) => {
  const { args, callbackId } = data;
  const argAction = args[0];
  const argEncodedMsg = args[1];
  try {
    const inputPtr = await wllamaMalloc(toSizeT(argEncodedMsg.byteLength), 0);
    // copy data to wasm heap
    const inputBuffer = new Uint8Array(
      getHeapU8().buffer,
      Number(inputPtr),
      argEncodedMsg.byteLength
    );
    inputBuffer.set(argEncodedMsg, 0);
    const outputPtr = await wllamaAction(argAction, inputPtr);
    // length of output buffer is written at the first 4 bytes of input buffer
    const outputLen = new Uint32Array(
      getHeapU8().buffer,
      Number(inputPtr),
      1
    )[0];
    // copy the output buffer to JS heap
    const outputBuffer = new Uint8Array(outputLen);
    const outputSrcView = new Uint8Array(
      getHeapU8().buffer,
      Number(outputPtr),
      outputLen
    );
    outputBuffer.set(outputSrcView, 0); // copy it
    msg({ callbackId, result: outputBuffer }, [outputBuffer.buffer]);
  } catch (err) {
    handleError(err);
  }
};

function handleError(err) {
  // If WASM already aborted, onAbort already sent signal.abort; skip to avoid
  // re-reporting the resulting WebAssembly.RuntimeError as a JS exception.
  if (isAborted) return;

  const message = err ? err.message || String(err) : 'Unknown error';
  const stack = err ? err.stack || String(err) : '';
  msg({
    verb: 'signal.abort',
    args: ['exception', message, stack, err],
  });
}
`;

/** Applies the llama-cpp.js hunk of a patch to a source text, the way the build applies it. */
function applyWorkerHunk(patch: string, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'sakutto-wllama-worker-'));
  try {
    // The include pattern is a patch path, so it keeps forward slashes on every platform.
    const file = 'src/workers-code/llama-cpp.js';
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    writeFileSync(join(directory, 'patch.diff'), patch);
    const applied = spawnSync(
      'git',
      ['apply', '--whitespace=nowarn', `--include=${file}`, 'patch.diff'],
      { cwd: directory, encoding: 'utf8' },
    );
    const patched = readFileSync(target, 'utf8');
    if (applied.status !== 0 || patched === source) {
      throw new Error(
        `the worker hunk does not apply to the pinned worker code: ${applied.stderr}`,
      );
    }
    return patched;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface PostedMessage {
  callbackId?: number;
  verb?: string;
  args?: unknown[];
  err?: string;
  result?: Uint8Array;
}

/**
 * Runs two action calls on the worker code: one whose action answers with a null pointer,
 * and one that arrives while the first is running. Returns what the worker posted.
 */
async function runWorkerCalls(source: string): Promise<PostedMessage[]> {
  const heap = new ArrayBuffer(64 * 1024);
  const heapBytes = new Uint8Array(heap);

  const posted: PostedMessage[] = [];
  const sandbox: Record<string, unknown> = {
    // the worker's own postMessage wrapper
    msg: (data: PostedMessage) => posted.push(data),
    getHeapU8: () => heapBytes,
    toSizeT: (size: number) => BigInt(size),
    isAborted: false,
    wllamaMalloc: async () => 1024n,
    wllamaAction: async (action: string, pointer: bigint) => {
      if (action === 'get_result') return 0n;
      // a real answer: the length goes to the first bytes of the request, the body follows
      new Uint32Array(heap, Number(pointer), 1)[0] = 4;
      heapBytes.set([71, 76, 85, 69], 4096);
      return 4096n;
    },
    console,
  };
  runInNewContext(
    `${source}
globalThis.calls = { runWasmCall, runAction };`,
    sandbox,
  );
  const { runWasmCall, runAction } = sandbox.calls as {
    runWasmCall: (callbackId: number, fn: () => Promise<void>) => Promise<void>;
    runAction: (data: { args: unknown[]; callbackId: number }) => Promise<void>;
  };

  // Every request starts with the protocol's magic number. When the native side returned
  // without writing the response length, that number was still there to be read as one.
  const request = new Uint8Array(16);
  request.set([0x47, 0x4c, 0x55, 0x45], 0);
  const first = runWasmCall(7, () => runAction({ args: ['get_result', request], callbackId: 7 }));
  void runWasmCall(8, () => runAction({ args: ['cancel', request], callbackId: 8 }));
  await first;
  for (let ticks = 0; posted.length < 2 && ticks < 50; ticks += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return posted;
}

describe('a failed action inside the wllama worker', () => {
  const patch = readFileSync(
    new URL('../scripts/wllama/patches/0018-failed-action-error-response.patch', import.meta.url),
    'utf8',
  );

  it('used to read the magic number as a length and signal an abort', async () => {
    const posted = await runWorkerCalls(WORKER_CALL_QUEUE);

    expect(posted).toHaveLength(2);
    const abort = posted[0];
    expect(abort).toMatchObject({ verb: 'signal.abort' });
    expect(abort?.args?.[0]).toBe('exception');
    expect(String(abort?.args?.[1])).toMatch(/Invalid typed array length: 1163217991/);
  });

  it('now fails the one call and lets the next one run', async () => {
    const posted = await runWorkerCalls(applyWorkerHunk(patch, WORKER_CALL_QUEUE));

    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      callbackId: 7,
      err: 'Action "get_result" failed, see the native log',
    });
    expect(posted[1]?.callbackId).toBe(8);
    expect(posted[1]?.verb).toBeUndefined();
    expect(Array.from(posted[1]?.result ?? [])).toEqual([71, 76, 85, 69]);
  });
});
