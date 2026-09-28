# raprid-cli

プロジェクト管理リポジトリの初期状態を生成し、管理操作のサブコマンドを実行する `raprid` CLI。
雛形は [project_template](https://github.com/shono1103/project_template) の特定コミットを同梱している。
npm レジストリには公開せず、GitHub Release に添付した tarball からインストールする。

## 必要なもの

* macOS または Linux (Windows は未対応。シンボリックリンクを含むため)
* Node.js 24 以上 (生成先の `scripts/cli.ts` も Node.js 24 の型除去で `.ts` を直接実行する)
* Git (生成先の `git init` に使う。無くても生成はできる)
* pnpm (生成先で依存を入れるとき)

## インストール

```sh
npm install -g https://github.com/raprid/raprid-cli/releases/latest/download/raprid.tgz
raprid --version
```

特定の版を入れる場合は、版ごとの tarball を指定する。

```sh
npm install -g https://github.com/raprid/raprid-cli/releases/download/v0.4.0/raprid-0.4.0.tgz
```

`npm install -g github:raprid/raprid-cli` は使わない。git 依存のインストールでは npm が `-g` を
ビルド用の内部 install にも引き継いでビルドに失敗し、GitHub の tarball 展開ではシンボリックリンクも落ちるため。
手元のソースから入れる場合は tarball を作ってインストールする。

```sh
pnpm install
npm pack                          # prepack でビルドし raprid-<version>.tgz を作る (private のため npm publish はできない)
npm install -g ./raprid-0.4.0.tgz
```

## 使い方

```sh
raprid init                       # 現在のディレクトリに生成する
raprid init my-project            # 指定したディレクトリに生成する (無ければ作る)
raprid init my-project --dry-run  # 衝突の確認だけ行う
raprid init my-project --no-git   # git init しない
```

生成後は表示される手順に従い、`pnpm install`、`raprid log create claude` を実行し、
`README.md` と `CLAUDE.md` を読んで使い始める。

### 管理操作のサブコマンド

`init` 以外は、生成したプロジェクト (管理リポジトリ) の `scripts/cli.ts` に処理を委譲する。
処理の実体はプロジェクトと一緒に版管理され、CLI はルートの判定と版の確認だけを行う。

```sh
raprid job create PROJ-123
raprid job list
raprid task list PROJ-123 --status todo,progress   # 既定は done 以外。--all で全件
raprid task show PROJ-123 T-001
raprid qa list --json                             # 機械向けの JSON (schemaVersion 1)
raprid task add PROJ-123 api-setup todo "API を用意する" --requested-by human/saiki --created-by agent/codex
raprid task move PROJ-123 T-001 progress
raprid task ask PROJ-123 T-001 deploy-policy customer "本番反映の手順はこれでよいか" --requested-by agent/codex --created-by agent/codex
raprid task note PROJ-123 T-001 investigation "既存 API の調査"
raprid qa resolve PROJ-123 Q-001 "この方針で進める" --answered-by human/saiki
raprid log create claude
raprid repo add git@github.com:example/foo.git 77
```

コマンドの一覧は管理リポジトリの中で `raprid <group> --help`、詳細は生成された README.md を参照。
CLI を入れていない環境では `pnpm raprid <group> <command>` か `node scripts/cli.ts <group> <command>` で同じ処理を呼べる。

* **ルートの判定**: カレントディレクトリから上へ、`scripts/package.json` (`raprid.protocol` を持つもの) と
  `scripts/cli.ts` があるディレクトリを探し、最も近いものを使う。Git リポジトリの境界
  (`.git` のあるディレクトリ) より上は探さない。子ディレクトリから実行しても操作先はそのルートになる。
* **版の互換性**: この CLI が対応する委譲プロトコルは `1`。プロジェクトの `protocol` が新しければ CLI の更新を、
  古ければプロジェクトの `scripts/` の更新を案内して終了する (終了コード 1)。
* **引数・入出力**: 引数はシェルを通さずにそのまま渡し、標準入出力と終了コードも引き継ぐ。

### 端末で閲覧する (raprid tui)

```sh
raprid tui              # 全案件
raprid tui PROJ-123     # 案件を指定して開く (g で切り替えられる)
raprid tui --actor human/saiki   # 更新する人を指定して開く (a で回答、m で状態変更)
```

タスク・QA・要確認 (不整合) を [GitUI](https://github.com/gitui-org/gitui) のようなキーボード中心の画面で閲覧する。
データは管理リポジトリの `scripts/` に `ui snapshot --json` (2 秒ごと) と `task/qa show --json` を
非同期の子プロセスで問い合わせて取得し、プロジェクトのコードは直接読み込まない。

* 画面の幅が 120 桁以上なら案件・一覧・詳細の 3 列、80〜119 桁なら一覧と詳細、40〜79 桁なら一覧だけ
  (Enter で詳細、Esc で戻る)。40 桁未満か 12 行未満では広げるよう案内し、選択や入力は保つ
* 主なキー: ↑↓ 移動、Tab / Shift+Tab パネル、1/2/3 task・QA・要確認、/ 検索、g 案件、f 状態の絞り込み、
  v 完了済みも表示、r 再取得、a 回答、m 状態変更、PageUp/PageDown 詳細のページ送り、? ヘルプ、q / Ctrl+C 終了。
  検索の入力中は文字をショートカットとして扱わない
* done / resolved は既定で隠す。選択は案件・種類・ID で追跡し、消えた場合は近くの項目へ移して知らせる
* 取得に失敗しても前回の表示を保ち「更新失敗」を出す。15 秒を超えた取得は止めて自動取得を停止し、r で再開する
* 代替画面・raw mode・カーソルは Ink が管理し、正常終了・Ctrl+C・SIGTERM・描画中の例外のいずれでも端末を戻す。
  実行中の取得用の子プロセスも止める
* **更新操作** (scripts/ が `guarded-write-v1` に対応している場合): QA の一覧で `a` を押すと回答欄
  (複数行。Enter は改行、Tab で保存/取消のボタン、貼り付け可、入力中の q・a・m は文字) が開き、
  タスクの一覧で `m` を押すと状態を選べる (pending は待ち理由が必須)。どちらも保存の前に確認画面を出す
* 更新する人は `raprid tui --actor human/<識別子>` か、最初の更新時の入力で指定する (ログイン名などから推測しない)。
  セッションの間だけ保ち、確認画面に表示する。requestedBy・createdBy は変えない
* 保存は開いた時点の revision を `--if-match` で渡す。別の操作が先に書き換えていたら保存せず、
  最新の内容と入力中の下書きを表示する (自動で再送しない)。保存中は操作と終了を受け付けず、終了の要求は保存の後に処理する
* 回答してもタスクは自動では再開しない。待っていたタスク (別案件の参照を含む) を示すので、選んで `m` で変更する。
  pending の解除は、待っている QA が解決済みでないと拒否され、QA 以外の待ちや done への変更は確認欄に印を付けてから行う

必要なもの: 端末 (TTY。パイプや `TERM=dumb` では起動せず、`raprid task list` / `qa list` の `--json` を案内する) と、
`query-v1` に対応した管理リポジトリの `scripts/` (`node scripts/cli.ts --capabilities` で確認できる)。
古い `scripts/` のプロジェクトでは更新が必要な旨を表示して終了し、init・移行・雛形の展開は勝手に行わない。
CLI を更新しただけでは既存プロジェクトの `scripts/` は変わらないので、project_template の `scripts/` を取り込む。

画面は [Ink](https://github.com/vadimdemedes/ink) 7 / React 19 で作り、`raprid tui` のときだけ読み込む
(通常のサブコマンドの起動には影響しない)。依存は `npm install -g` で一緒に導入される。

### 旧構成のプロジェクトを移行する

raprid 0.1.x で生成したプロジェクトなど、`job/<案件名>/list/` と `job/*.sh` を使う旧構成には委譲先の
`scripts/` が無い。`raprid job migrate` だけは CLI に同梱した移行処理 (雛形の `scripts/`) を一時展開して実行し、
移行と同時に `scripts/` を導入する。移行後は通常どおり委譲する。

```sh
raprid job migrate --dry-run                 # 変換計画 (パスの対応・書き換えるリンク・保留項目) を表示
raprid job migrate --apply --plan <ハッシュ> # 表示した計画と一致する場合だけ実行する
raprid job migrate --restore <移行ID>        # 移行前に戻す
```

`raprid init` を旧プロジェクトに実行して代用しない (衝突で止まる)。移行の仕様と制約は生成された README.md の
「旧構成からの移行」を参照。旧パスを直接読む外部ツールは移行後に新しいパスへ合わせる必要がある。

### 生成するもの・しないもの

生成するのは同梱した雛形 (`template/`) の内容だけ。
README、エージェント向け指示 (CLAUDE.md / AGENTS.md)、共有スキル (`.claude/skills/`、`.agents/skills` のリンク)、
`docs/`、`logs/`、`jobs/other/` (Markdown 方式の案件管理)、`scripts/` (サブコマンドの実装・雛形・テスト)、`repos/`、
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
* 生成先そのものにシンボリックリンクは指定できない
* 同じ場所で再実行すると、生成済みのファイルがすべて衝突になり、何も変更しない
* 生成中に書き込みに失敗した場合は、その実行で作ったファイルとディレクトリだけを削除して終了する

`--force` のような上書きの手段は用意していない。やり直す場合は生成先を空にしてから実行する。

### Git の扱い

生成先が Git 作業ツリーの外なら `git init` だけを行う。コミットはしない。
既に Git 作業ツリーの中 (生成先自身が Git リポジトリ、または親ディレクトリのリポジトリ内) なら `git init` しない。
`git` が使えない場合は警告して生成結果はそのまま残す。
`GIT_DIR` などの `GIT_*` 環境変数は無視し、必ず生成先に対して実行する。依存のインストールも自動では行わない。

### 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 (`--dry-run` で衝突が無い場合を含む) |
| 1 | 生成・操作できなかった (衝突、書き込み失敗、生成先がディレクトリではない・確認できない、管理リポジトリが無い、版が非対応) |
| 2 | 引数の誤り |

## 更新

CLI を新しくするには、インストールと同じコマンドをもう一度実行する。
npm のキャッシュで古い版が入る場合は `--prefer-online` を付けるか、版ごとの tarball を指定する。

```sh
npm install -g --prefer-online https://github.com/raprid/raprid-cli/releases/latest/download/raprid.tgz
```

**`raprid init` は新規作成専用で、生成済みのプロジェクトは更新しない。**
CLI を更新しても、サブコマンドの処理は各プロジェクトの `scripts/` が行うため、プロジェクト側の動作は変わらない。
生成後のプロジェクトは独立したリポジトリとして運用する。雛形の変更を既存プロジェクトへ取り込む場合は、
`template-source.json` が指すコミットと project_template の差分を見て、必要なものを手で反映する。

## 開発

```text
.
├── src/                      # CLI 本体 (cli.ts / init.ts / delegate.ts / bundle.ts)
│   └── tui/                  # raprid tui (backend・stores: 取得、model: 状態とキー操作、app.tsx: Ink の画面)
├── scripts/
│   ├── sync-template.ts      # project_template から template/ を作り直す
│   └── bundle-template.ts    # template/ を dist/template.json にまとめる (build の一部)
├── template/                 # 同梱する雛形 (直接編集しない)
├── template-source.json      # template/ の取り込み元リポジトリ・ref・コミット
├── template-links.json       # 雛形のシンボリックリンク (template/ には置かない)
├── overrides/                # 雛形を初期状態にするための差し替えファイル
└── test/                     # node:test の結合テスト (tui-*.test.ts は画面、pty-harness.py は疑似端末)
```

```sh
pnpm install
pnpm typecheck
pnpm test                     # build してから dist/cli.js を一時ディレクトリで実行する
```

`test/tui-pty.test.ts` は `python3` の `pty` で疑似端末を作り、キー操作・端末サイズの変更・SIGTERM・
描画中の例外の後に端末が元に戻ることを確かめる (python3 が無い環境では飛ばす)。
実端末での日本語入力・貼り付けなどは自動試験の対象外なので、`docs/feature` の手順で人が確認する。

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
取り込み元の URL は配布物に入るため、origin の URL から認証情報を除いて記録する (origin が無い場合は中止する)。
`template/` の外を指すシンボリックリンクがあるとビルドを中止する。

npm pack はシンボリックリンクや `.gitignore` をそのまま同梱できないため、
配布物には `template/` と `template-links.json` を種別・実行権限ごと 1 つの JSON (`dist/template.json`) にまとめて入れる。
同じ理由で、同期時に雛形のシンボリックリンクは `template/` から除き `template-links.json` に記録する。

### 配布物を確認する

```sh
npm pack --dry-run                                    # 同梱一覧 (dist/ と package.json など)
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" ./raprid-0.4.0.tgz
"$prefix/bin/raprid" init "$(mktemp -d)/sample"
```

### リリースする

`package.json` の `version` を上げてコミット・push した後、tarball を作って GitHub Release に添付する。
`raprid.tgz` (最新版の固定名) と `raprid-<version>.tgz` (版ごと) の 2 つを付ける。

```sh
pnpm test
npm pack
cp raprid-0.4.0.tgz raprid.tgz
gh release create v0.4.0 raprid.tgz raprid-0.4.0.tgz --title v0.4.0 --notes "雛形: project_template <コミット>"
```

## ライセンス

MIT
