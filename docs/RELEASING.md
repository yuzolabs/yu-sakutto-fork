# リリース手順

English: [RELEASING.en.md](RELEASING.en.md)

## ローカルでバージョンを上げる

`main` の作業ツリーがきれいなときだけ、次のいずれかが動きます。

```bash
pnpm release patch
pnpm release minor
pnpm release major
```

コマンドは次を行います。

1. ブランチが `main` でない、未コミットの変更（未追跡のファイルを含む）がある、または上げた版が `main` に取り込まれている最新の `vX.Y.Z` タグより新しくないとき、何も変えずに止まります。
2. `package.json` の `version` を上げます。WXT は拡張機能の manifest version をこの値から作ります。`wxt.config.ts` に `version` や `version_name` は書かないでください。書いた状態ではコマンドが止まります。
3. 直前の `vX.Y.Z` タグ以降のコミット件名で、`CHANGELOG.md` に節を追加します。タグがまだ無いときは、履歴全体が対象です。マージコミットは入れません。日付は UTC です。
4. `chore: release vX.Y.Z` というコミットを作ります。
5. 注釈付きタグ `vX.Y.Z` を作ります。タグを作れなかったときは、そのリリースのコミットも取り消します。
6. push はしません。最後の行に、実行すべきコマンドを出します。

```bash
git push origin main vX.Y.Z
```

表示されたコマンドで、`main` とそのタグを push してください。タグの push が Release ワークフローを開始します。push する前に `git show` でコミットとタグを確認できます。

リモートの `main` が進んでいると push は拒否されます。そのときは `main` を更新し、リリースのコミットを載せ直してから、同じ形のコマンドを実行してください。

## タグを push したあと

[`.github/workflows/release.yml`](../.github/workflows/release.yml) が `v*` のタグで動きます。通常の pull request ではこのワークフローは動きません。

1. タグ名が `package.json` の version に `v` を付けたものと一致することを確認します。`CHANGELOG.md` にその版の節があることも確認します。
2. 既存の CI と同じく、lint、format、typecheck、unit test、e2e を実行します。Checks の checkout は `fetch-depth: 0` です（`tests/bench-fixtures.test.ts` が履歴のコミットを参照するため）。
3. 既存の package アクション（[`.github/actions/package-extension`](../.github/actions/package-extension/action.yml)）で、wllama を **ソースから** ビルドします（`from-source: true`。CI の wasm キャッシュは使いません）。`pnpm zip`、パッケージ検査（`scripts/verify-package.ts`）、worker のスモークテストを行います。
4. ビルドした `manifest.json` の version が `package.json` と一致することを確認します。
5. GitHub Release を下書きで作り、Chrome 用 zip を添付し、`CHANGELOG.md` のその節を本文にします。下書きは自動では公開しません。

## 更新とモデル

拡張機能の更新では、拡張機能 ID は変わりません。モデルの重みは、その ID のオリジンに紐づく OPFS（Origin Private File System）に保存します。実装は `OpfsModelFileStore` で、`navigator.storage.getDirectory()` の `sakutto` ディレクトリです。

拡張機能のプログラムだけが変わる更新では、保存済みのモデルを再ダウンロードしません。完成しているかの判定は、保存した `model.json` の SHA-256 およびサイズと、実ファイルのサイズが、カタログ `src/engine/model/catalog.ts` の値と一致するかどうかです。カタログの SHA-256 またはサイズが変わったときは、保存済みのファイルを完成品として扱わないため、モデルを再度ダウンロードします。利用者がモデルを削除したときも、次に使うときにダウンロードします。

別の拡張機能 ID で読み込んだパッケージ（たとえばパッケージ化されていない拡張機能）はオリジンが違うため、モデルを共有しません。

## 関連

- ビルド: [BUILDING.md](BUILDING.md)
