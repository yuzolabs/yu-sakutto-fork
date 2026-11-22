# Releasing

日本語: [RELEASING.md](RELEASING.md)

From a clean `main` checkout:

```bash
pnpm release patch
pnpm release minor
pnpm release major
```

The command refuses a dirty tree, including untracked files, and any branch other than `main`. It also refuses a version that is not newer than the highest `vX.Y.Z` tag merged into `main`. It bumps the `version` in `package.json`. WXT copies that value into the extension manifest, so do not set `version` or `version_name` in `wxt.config.ts`. It prepends a `CHANGELOG.md` section made from commit subjects since the previous `vX.Y.Z` tag, or from the whole history when no release tag exists. It commits `chore: release vX.Y.Z` and creates an annotated tag. If the tag cannot be created, that commit is removed. It does not push. The last line of output is the command to run:

```bash
git push origin main vX.Y.Z
```

Pushing that tag runs `.github/workflows/release.yml`. Pull requests do not run it. The workflow checks the tag against `package.json` and `CHANGELOG.md`, runs the same lint, format, typecheck, unit, and e2e checks as CI (with `fetch-depth: 0` so `tests/bench-fixtures.test.ts` can see history), then runs the existing package action with `from-source: true`. That action compiles wllama from source rather than restoring the CI wasm cache, runs `pnpm zip` (including the package audit), and smoke-tests the worker. The workflow then checks the built manifest version and opens a draft GitHub Release with the Chrome zip attached and the changelog section as the notes. See [CI.md](CI.md).

The model stored in OPFS is not downloaded again on an extension update unless the model changes. An extension update keeps the extension id, so the origin and its OPFS directory (`sakutto`, from `navigator.storage.getDirectory()`) remain. The saved file stays ready while its SHA-256 and size match `src/engine/model/catalog.ts`. A new catalog hash or size, or a delete by the user, downloads the model again. An unpacked extension with a different id does not share that storage.
