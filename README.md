# raprid-cli

プロジェクト管理リポジトリの初期状態を生成する `raprid` CLI。
雛形は [project_template](https://github.com/shono1103/project_template) の特定コミットを同梱している。
npm レジストリには公開していないため、GitHub またはローカルの tarball からインストールする。

## 必要なもの

* Node.js 24 以上 (生成先の `pnpm log:create` も Node.js 24 の型除去で `.ts` を直接実行する)
* Git (生成先の `git init` に使う。無くても生成はできる)
* pnpm (生成先で依存を入れるとき)

## インストール

```sh
npm install -g github:raprid/raprid-cli
raprid --version
```

GitHub からのインストールでは、npm が依存を入れて `prepare` (ビルド) を実行してからインストールする。
手元のソースから入れる場合は tarball を作ってインストールする。

```sh
pnpm install
npm pack                          # raprid-<version>.tgz ができる
npm install -g ./raprid-0.1.0.tgz
```

## 使い方

```sh
raprid init                       # 現在のディレクトリに生成する
raprid init my-project            # 指定したディレクトリに生成する (無ければ作る)
raprid init my-project --dry-run  # 衝突の確認だけ行う
raprid init my-project --no-git   # git init しない
```

生成後は表示される手順に従い、`pnpm install`、`pnpm log:create claude` を実行し、
`README.md` と `CLAUDE.md` を読んで使い始める。

### 生成するもの・しないもの

生成するのは同梱した雛形 (`template/`) の内容だけ。
README、エージェント向け指示 (CLAUDE.md / AGENTS.md)、共有スキル (`.claude/skills/`、`.agents/skills` のリンク)、
`docs/`、`logs/` (作成スクリプトと雛形)、`job/` (Markdown 方式の案件管理と操作スクリプト)、`repos/` の管理スクリプト、
`package.json` などを含む。

次は持ち込まない。

* project_template の Git 履歴
* テンプレート自身の作業記録 (`logs/<YYYY>/...`) とテンプレート開発用の手順書 (`docs/feature/` の `.feature`)
* `MEMORY.md` などの現在状況 (初期状態のものに差し替える)
* `node_modules/` などの Git 管理外のファイル

### 既存ファイルがある場合

**書き込む前に、生成する全ファイルについて衝突を確認する。1 件でも衝突があれば何も書かずに終了する。**

* 生成先のディレクトリが空でなくても、衝突が無ければ生成する (既存の `.git` や無関係なファイルは残る)
* 生成するパスに既存のファイル・ディレクトリ・シンボリックリンクがあれば衝突とする
* 途中の階層がファイルやシンボリックリンクの場合も衝突とする (リンク先の外部へ書き込まないため)
* 同じ場所で再実行すると、生成済みのファイルがすべて衝突になり、何も変更しない
* 生成中に書き込みに失敗した場合は、その実行で作ったファイルとディレクトリだけを削除して終了する

`--force` のような上書きの手段は用意していない。やり直す場合は生成先を空にしてから実行する。

### Git の扱い

生成先が Git 作業ツリーの外なら `git init` だけを行う。コミットはしない。
既に Git 作業ツリーの中 (生成先自身が Git リポジトリ、または親ディレクトリのリポジトリ内) なら `git init` しない。
`git` が使えない場合は警告して生成結果はそのまま残す。依存のインストールも自動では行わない。

### 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 (`--dry-run` で衝突が無い場合を含む) |
| 1 | 生成できなかった (衝突、書き込み失敗、生成先がディレクトリではない) |
| 2 | 引数の誤り |

## 更新

CLI を新しくするには、インストールと同じコマンドをもう一度実行する。

```sh
npm install -g github:raprid/raprid-cli
```

**`raprid init` は新規作成専用で、生成済みのプロジェクトは更新しない。**
生成後のプロジェクトは独立したリポジトリとして運用する。雛形の変更を既存プロジェクトへ取り込む場合は、
`template-source.json` が指すコミットと project_template の差分を見て、必要なものを手で反映する。

## 開発

```text
.
├── src/                      # CLI 本体 (cli.ts / init.ts / bundle.ts)
├── scripts/
│   ├── sync-template.ts      # project_template から template/ を作り直す
│   └── bundle-template.ts    # template/ を dist/template.json にまとめる (build の一部)
├── template/                 # 同梱する雛形 (直接編集しない)
├── template-source.json      # template/ の取り込み元リポジトリ・ref・コミット
├── overrides/                # 雛形を初期状態にするための差し替えファイル
└── test/                     # node:test の結合テスト
```

```sh
pnpm install
pnpm typecheck
pnpm test                     # build してから dist/cli.js を一時ディレクトリで実行する
```

### 雛形を更新する

**雛形の正本は project_template。`template/` は直接編集せず、同期スクリプトで作り直す。**

```sh
pnpm template:sync ../project_template                       # チェックアウト中の HEAD から
pnpm template:sync ../project_template --ref origin/main     # ref を指定する
pnpm test
```

同期は Git 管理下のファイルだけを `git archive` で取り出し、上記の「持ち込まない」ものを除いて
`overrides/` のファイルで上書きする。除外と上書きの一覧が表示されるので、差分と合わせて確認してからコミットする。
`overrides/` の上書き先が雛形から消えた場合は同期を中止するので、`overrides/` を見直す。

npm pack はシンボリックリンクや `.gitignore` をそのまま同梱できないため、
配布物には `template/` を種別・実行権限ごと 1 つの JSON (`dist/template.json`) にまとめて入れる。

### 配布物を確認する

```sh
npm pack --dry-run                                    # 同梱一覧 (dist/ と package.json など)
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" ./raprid-0.1.0.tgz
"$prefix/bin/raprid" init "$(mktemp -d)/sample"
```

## ライセンス

MIT
