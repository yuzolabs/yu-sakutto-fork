import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitArtifacts, type BuildInputs } from './artifacts.ts';
import { buildWasm, emsdkTag } from './docker.ts';
import { LLAMA_CPP_COMMIT, WLLAMA_COMMIT, WLLAMA_REPOSITORY } from './pins.ts';
import { exists, log, readText, run, sha256 } from './support.ts';
import { assertWave64ProbePlacement } from './webgpu-patch.ts';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR_DIR = join(ROOT_DIR, 'vendor', 'wllama');
const CHECKOUT_DIR = join(VENDOR_DIR, '.checkout');
const DIST_DIR = join(VENDOR_DIR, 'dist');
const STAGING_DIR = join(VENDOR_DIR, '.dist-staging');
const PUBLIC_DIR = join(ROOT_DIR, 'public', 'vendor', 'wllama');
const PATCH_DIR = join(ROOT_DIR, 'scripts', 'wllama', 'patches');

const PATCH_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['src/utils.ts', 'return new Worker(url.href);'],
  ['src/utils.ts', "url.searchParams.set('options', JSON.stringify(runOptions));"],
  ['src/worker.ts', 'this.worker = createWorker(this.resources.workerUrl, runOptions);'],
  ['src/worker.ts', 'compat ? this.resources.compatPthreadUrl : this.resources.pthreadUrl'],
  ['src/wllama.ts', "this.pathConfig['wllama.worker.js']"],
  ['src/wllama.ts', "this.pathConfig['wllama.pthread.js']"],
  ['src/wllama.ts', "const compatWasm = this.pathConfig['wllama.compat.wasm'];"],
  [
    'scripts/docker-compose.yml',
    'emcmake cmake .. -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 -DGGML_WEBGPU=ON',
  ],
  [
    'scripts/docker-compose.yml',
    'emcmake cmake .. -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 -DWLLAMA_COMPAT=ON',
  ],
  ['scripts/docker-compose.yml', 'head -c 2 emdawn.zip'],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'std::unordered_map<std::string, wgpu::BindGroup> bind_group_cache;',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'ctx->param_arena.flush(ctx->global_ctx->queue);',
  ],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ggml_webgpu_append_mmvq_columns(ctx, src0'],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ggml_webgpu: device ready'],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ggml_webgpu_try_request_device'],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ggml_webgpu: device features:'],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ggml_webgpu_apply_granted_device_caps'],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'caps.flash_attn_vec'],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'static const char * ggml_webgpu_probe_f16_sum_wgsl()',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp',
    'key.use_mmvq && context.supports_subgroups && context.vendor == "nvidia"',
  ],
  ['llama.cpp/common/sampling.cpp', 'if (common_sampler_takes_max(gsmpl, ctx)) {'],
  ['llama.cpp/common/sampling.cpp', 'llama_get_argmax_ith(ctx, idx);'],
  [
    'llama.cpp/src/llama-context.cpp',
    'res->t_argmax = ggml_argmax(res->get_ctx(), res->get_logits());',
  ],
  ['llama.cpp/src/llama-context.cpp', 'void llama_context::argmax_forget() {'],
  [
    'llama.cpp/tools/server/server-context.cpp',
    'llama_set_argmax_only(ctx_tgt, slots_take_max());',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/wgsl-shaders/argmax.wgsl',
    'dst[params.offset_dst + wid.x] = max(shared_max[0].index, 0);',
  ],
  ['cpp/wllama-context.h', 'if (!next.first && rd.has_next())'],
  [
    'llama.cpp/ggml/src/ggml-webgpu/wgsl-shaders/flash_attn_tile.wgsl',
    'if (bitcast<u32>(f32(mask[mask_idx])) != 0xff800000u) {',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'vec flash-attn off (wave64), tile shader only',
  ],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'ok vendor=%s subgroups=%s subgroup_size=%u'],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp',
    'inline bool ggml_webgpu_adapter_is_amd(',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp',
    'bool ggml_backend_webgpu_dev_is_amd(ggml_backend_dev_t dev) {',
  ],
  [
    'llama.cpp/ggml/include/ggml-webgpu.h',
    'GGML_BACKEND_API bool ggml_backend_webgpu_dev_is_amd(ggml_backend_dev_t dev);',
  ],
  ['llama.cpp/src/llama-context.cpp', '!ggml_backend_webgpu_dev_is_amd(model.dev_output())'],
  [
    'llama.cpp/ggml/src/ggml-webgpu/wgsl-shaders/flash_attn_tile.wgsl',
    '#if defined(MASK) && defined(SKIP_MASKED_TILES)',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp',
    'defines.push_back("SKIP_MASKED_TILES");',
  ],
  [
    'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp',
    '!ggml_webgpu_adapter_is_amd(context.vendor, context.architecture)',
  ],
  ['llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp', 'op.shader_lib_ctx.architecture'],
  ['src/utils.ts', 'webgpuDebug?: string'],
  ['src/worker.ts', '__SAKUTTO_WEBGPU_DEBUG__'],
  ['cpp/wllama-context.h', 'params.n_ctx_checkpoints = 0;'],
  ['cpp/wllama-context.h', 'params.cache_ram_mib = 0;'],
  [
    'llama.cpp/tools/server/server-context.cpp',
    'task->is_stateless() || !task->params.cache_prompt',
  ],
  ['cpp/wllama-context.h', 'res.data_json.value = result ? safe_json_to_str(data_json) : "";'],
  ['cpp/wllama.cpp', 'glue_msg_error err;'],
  ['src/worker.ts', "if (parsedResult._name === 'erro_evt') {"],
  ['src/workers-code/llama-cpp.js', 'if (!Number(outputPtr)) {'],
  // tests/wllama-build.test.ts runs a copy of this worker code; these lines make wllama:check
  // fail when a pin bump changes it.
  ['src/workers-code/llama-cpp.js', 'wasmCallQueue.length = 0;'],
  ['src/workers-code/llama-cpp.js', "args: ['exception', message, stack, err],"],
];

/**
 * `core.longpaths` lets the llama.cpp submodule check out on a Windows host whose checkout
 * path is longer than MAX_PATH (a worktree with a long branch name, for example).
 */
const GIT_CONFIG_ARGS = [
  'core.hooksPath=',
  'core.autocrlf=false',
  'core.eol=lf',
  'core.longpaths=true',
];

function git(args: readonly string[], cwd = CHECKOUT_DIR): Promise<string> {
  const config = GIT_CONFIG_ARGS.flatMap((setting) => ['-c', setting]);
  return run('git', [...config, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export async function ensureCheckout(targets: {
  checkoutDir: string;
  repository: string;
  wllamaCommit: string;
  llamaCppCommit: string;
}): Promise<void> {
  const { checkoutDir, repository, wllamaCommit, llamaCppCommit } = targets;

  if (await exists(join(checkoutDir, '.git'))) {
    const origin = await git(['config', '--get', 'remote.origin.url'], checkoutDir).catch(() => '');
    if (origin && origin !== repository) {
      throw new Error(
        `${checkoutDir} points at ${origin}, expected ${repository}. Remove the directory and retry.`,
      );
    }
    if (!origin) {
      await git(['remote', 'add', 'origin', repository], checkoutDir);
    }
  } else {
    await mkdir(checkoutDir, { recursive: true });
    await git(['init', '--quiet'], checkoutDir);
    await git(['remote', 'add', 'origin', repository], checkoutDir);
    log(`cloned ${repository}`);
  }

  await git(['config', 'core.autocrlf', 'false'], checkoutDir);
  await git(['config', 'core.eol', 'lf'], checkoutDir);

  const head = await git(['rev-parse', 'HEAD'], checkoutDir).catch(() => '');
  if (head !== wllamaCommit) {
    const known = await git(['cat-file', '-e', `${wllamaCommit}^{commit}`], checkoutDir).then(
      () => true,
      () => false,
    );
    if (!known) {
      log(`fetching ${wllamaCommit}`);
      try {
        await git(['fetch', '--depth', '1', 'origin', wllamaCommit], checkoutDir);
      } catch {
        await git(['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], checkoutDir);
      }
    }
    await git(['checkout', '--detach', wllamaCommit], checkoutDir);
  }

  const pinned = await git(['rev-parse', 'HEAD'], checkoutDir);
  if (pinned !== wllamaCommit) {
    throw new Error(`wllama checkout is at ${pinned}, expected ${wllamaCommit}`);
  }

  const linked = await git(['rev-parse', 'HEAD:llama.cpp'], checkoutDir);
  if (linked !== llamaCppCommit) {
    throw new Error(`wllama @${wllamaCommit} expects llama.cpp ${llamaCppCommit}, found ${linked}`);
  }

  // Without its own .git, rev-parse in llama.cpp would read the superproject's HEAD.
  const llamaCppDir = join(checkoutDir, 'llama.cpp');
  let llamaCpp = (await exists(join(llamaCppDir, '.git')))
    ? await git(['rev-parse', 'HEAD'], llamaCppDir).catch(() => '')
    : '';
  // A submodule checkout that failed part way ("Filename too long", for example) leaves
  // llama.cpp/.git on the clone's default branch, so the update runs again in that state too.
  if (llamaCpp !== llamaCppCommit) {
    log(`checking out the llama.cpp submodule @${llamaCppCommit}`);
    try {
      await git(['submodule', 'update', '--init', '--recursive', '--depth', '1'], checkoutDir);
    } catch {
      await git(['submodule', 'update', '--init', '--recursive'], checkoutDir);
    }
    llamaCpp = await git(['rev-parse', 'HEAD'], llamaCppDir);
  }

  if (llamaCpp !== llamaCppCommit) {
    throw new Error(`llama.cpp checkout is at ${llamaCpp}, expected ${llamaCppCommit}`);
  }
}

async function resetCheckout(): Promise<void> {
  // A superproject reset leaves the submodule's files alone, and a patch applies into llama.cpp.
  await git(['checkout', '--', '.'], join(CHECKOUT_DIR, 'llama.cpp'));
  await git(['reset', '--hard', WLLAMA_COMMIT]);
  await git([
    'clean',
    '-fd',
    '-e',
    'node_modules',
    '-e',
    '.npm-cache',
    '-e',
    'build',
    '-e',
    'build-compat',
    '-e',
    'esm',
  ]);
}

async function applyPatches(): Promise<void> {
  const patches = (await readdir(PATCH_DIR)).filter((name) => name.endsWith('.patch')).sort();
  if (patches.length === 0) {
    throw new Error(`no patches found in ${PATCH_DIR}`);
  }

  for (const name of patches) {
    const patch = join(PATCH_DIR, name);
    try {
      await git(['apply', '--check', patch]);
    } catch (error) {
      throw new Error(
        `${name} does not apply to wllama @${WLLAMA_COMMIT}. Review the patch against the pinned source.`,
        { cause: error },
      );
    }
    await git(['apply', patch]);
    log(`applied ${name}`);
  }

  for (const [file, marker] of PATCH_MARKERS) {
    const contents = await readText(join(CHECKOUT_DIR, file));
    if (!contents.includes(marker)) {
      throw new Error(
        `${file} does not contain the expected patched code (${marker}). Review the patches against the pinned source.`,
      );
    }
  }

  const webgpu = await readText(
    join(CHECKOUT_DIR, 'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp'),
  );
  assertWave64ProbePlacement(webgpu);
}

async function runNpm(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform === 'win32') {
    // npm is a .cmd shim, so it has to run through the command interpreter.
    await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd: CHECKOUT_DIR,
      env,
      mode: 'inherit',
    });
  } else {
    await run('npm', args, { cwd: CHECKOUT_DIR, env, mode: 'inherit' });
  }
}

async function buildLibrary(): Promise<{ tsupVersion: string }> {
  log('installing wllama build dependencies');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: join(VENDOR_DIR, '.npm-cache'),
  };

  await runNpm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], env);

  log('bundling the wllama library');
  await runNpm(
    ['exec', '--', 'tsup', 'src/index.ts', '--format', 'cjs,esm', '--clean'],
    process.env,
  );

  if (!(await exists(join(CHECKOUT_DIR, 'esm', 'index.js')))) {
    throw new Error('the wllama library build did not produce esm/index.js');
  }

  const packageJson = JSON.parse(
    await readText(join(CHECKOUT_DIR, 'node_modules', 'tsup', 'package.json')),
  ) as { version?: unknown };
  if (typeof packageJson.version !== 'string') {
    throw new Error('the tsup package does not declare a version');
  }
  return { tsupVersion: packageJson.version };
}

async function syncPublicAssets(): Promise<void> {
  await rm(PUBLIC_DIR, { recursive: true, force: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  for (const name of await readdir(DIST_DIR)) {
    await copyFile(join(DIST_DIR, name), join(PUBLIC_DIR, name));
  }

  log(`copied the assets to ${PUBLIC_DIR}`);
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  log(`pinned wllama @${WLLAMA_COMMIT} with llama.cpp @${LLAMA_CPP_COMMIT}`);

  if (!checkOnly) {
    await rm(PUBLIC_DIR, { recursive: true, force: true });
  }

  await ensureCheckout({
    checkoutDir: CHECKOUT_DIR,
    repository: WLLAMA_REPOSITORY,
    wllamaCommit: WLLAMA_COMMIT,
    llamaCppCommit: LLAMA_CPP_COMMIT,
  });
  await resetCheckout();
  await applyPatches();

  if (checkOnly) {
    log('the pinned sources and patches are valid');
    return;
  }

  const compat = process.env.SKIP_COMPAT !== '1';
  const { tsupVersion } = await buildLibrary();
  const tag = emsdkTag(process.arch);
  await buildWasm(CHECKOUT_DIR, process.arch, compat);

  const packageLockSha256 = sha256(await readFile(join(CHECKOUT_DIR, 'package-lock.json')));
  const inputs: BuildInputs = {
    emscriptenTag: tag,
    compat,
    tsupVersion,
    packageLockSha256,
  };

  await rm(DIST_DIR, { recursive: true, force: true });
  await rm(STAGING_DIR, { recursive: true, force: true });
  await emitArtifacts(STAGING_DIR, PATCH_DIR, CHECKOUT_DIR, inputs);
  await rename(STAGING_DIR, DIST_DIR);
  await syncPublicAssets();
  log('done');
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPoint === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`[wllama] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
