# project-template

プロジェクト管理用のリポジトリ。agent の作業記録・案件のタスク・Q&A・関連リポジトリを1箇所に集約する。

## ディレクトリ構成

```
.
├── README.md                    # このファイル (構成と運用ルール)
├── CLAUDE.md                    # Claude Code 向けの入口
├── AGENTS.md                    # Codex 向けの入口 (共通ルールへの参照と差分)
├── .agents/skills -> ../.claude/skills  # Codex から共有スキルを発見する入口
├── MEMORY.md                    # プロジェクト状態のダイジェスト (自動生成)
├── package.json                 # pnpm スクリプト (raprid / log:create / test / typecheck)。Node.js 24 以上
├── tsconfig.json
├── scripts/                     # 管理操作の実装 (サブコマンド・雛形・テスト)
│   ├── cli.ts                   # raprid / pnpm raprid の共通入口
│   ├── commands/  lib/  test/
│   └── templates/               # 案件・タスク・QA・ログ・repos 管理文書の雛形
├── .claude/
│   ├── agents/
│   │   └── task-transition.md   # タスクの状態遷移を行うエージェント
│   └── skills/
│       ├── reload-project/      # MEMORY.md を再生成する
│       ├── add-task/            # 案件とタスクを対話的に追加する
│       ├── list-task/           # タスクを状態別に一覧表示する
│       ├── list-qa/             # QA を状態別に一覧表示する
│       ├── task-transition/     # 状態・日付・依存関係と索引を一緒に更新する
│       ├── verify-task/         # 手順書をもとに対話で動作確認する
│       ├── run-manual-test/     # 手順書をブラウザで実行し GIF を撮る
│       ├── build-release-diff-sheet/   # リリース資料の「プログラムの変更箇所」を作る
│       ├── build-release-check-sheet/  # リリース資料の「確認手順」を手順書から起こす
│       ├── fill-release-check-result/  # 確認結果とエビデンスを記入する
│       └── release-doc-common/         # リリース資料 3 スキルの共通資材
├── logs/                        # agent のセッションログ
│   ├── README.md
│   └── <YYYY>/<MM>/<DD>/<agent_name>/<session_id>/
├── docs/                        # プロジェクト関連ドキュメント
│   ├── README.md
│   ├── feature/                 # Gherkinの仕様・手動テスト手順
│   ├── official/                # 公式 (正式に合意・承認されたもの)
│   ├── unofficial/              # 非公式 (共有はするが未確定のもの)
│   └── personal/                # 個人 (自分だけが使うもの)
├── jobs/                        # 案件・タスク管理
│   ├── other/                   # 特定案件に属さないタスク・QA
│   └── <案件名>/
│       ├── tasks/<タスク名>/    # タスクの実体 (index.md・詳細 md・assets/)
│       ├── status/{todo,pending,progress,done}/ # タスクの状態索引
│       ├── qa/<QA名>/           # QA の実体 (index.md・資料)
│       ├── qa/status/{unresolved,resolved}/     # QA の状態索引
│       └── assets/              # 案件共通の補助ツール
├── repos/                       # 関連リポジトリ (submodule)
│   ├── README.md
│   └── <リポジトリ名>/
│       ├── repo/                # ローカル動作確認用 worktree
│       ├── .worktrees/          # 作業・リモートブランチ用 worktree（Git 管理外）
│       ├── MEMORY.md            # 現在のブランチ・HEAD・作業ツリー
│       ├── BRANCH.md            # Gherkin 形式のブランチ運用規約
│       └── WORKTREES.md         # worktree の配置・統合手順
```

雛形は `scripts/templates/` の1か所に置く。複製元なので、テンプレート自体のルールを変えたいときだけ編集する。

## Claude Code と Codex で使う

Claude Code は `CLAUDE.md`、Codex は `AGENTS.md` を入口にする。
共通の構成・状態管理はこの README を正とし、Codex の入口には読み込み方と差分だけを書く。

スキルの本体・補助スクリプト・雛形は `.claude/skills/` に一つだけ置く。
`.agents/skills` は `../.claude/skills` への相対シンボリックリンクで、コピーは作らない。
このため Claude 用のパスを変えずに、Codex からも同じスキルを利用できる。
`runtime.md` と `release-doc-common/` は共有資材で、単独のスキルではない。

| 操作 | Claude Code | Codex |
| --- | --- | --- |
| 状況を読み込む | `CLAUDE.md` と `MEMORY.md` | `AGENTS.md` から共通文書と `MEMORY.md` を読む |
| タスク一覧 | `/list-task <案件名>` | `$list-task <案件名>` |
| タスク追加 | `/add-task` | `$add-task` |
| 状態変更 | `/task-transition` (専用エージェントからも利用可) | `$task-transition` |
| 状態の要約を更新 | `/reload-project` | `$reload-project` |
| 作業記録 | `logs/<year>/<month>/<day>/claude/<session_id>/` | `logs/<year>/<month>/<day>/codex/<session_id>/` |

他のスキルも同じ呼び分けで使える。自然文での依頼でもよい。
共通のツール対応・記録・変更範囲は [.claude/skills/runtime.md](.claude/skills/runtime.md) を参照。
Claude in Chrome や専用エージェントの設定は Codex に自動移植されないため、
ブラウザ操作は利用可能なツールか、案件に用意した実行コードを使う。
読み込みや一覧だけの依頼ではファイルを更新せず、変更作業の区切りにセッションログと MEMORY を更新する。

Codex の新しいセッションで「利用できるプロジェクトスキルを確認して」と頼み、
10 本 (タスク管理 5、動作確認 2、リリース資料 3) を認識しているか確認できる。
リンクを失う形式でコピー・展開した場合は、まず `ls -ld .agents/skills` と
`readlink .agents/skills` を確認する。通常ファイルや実ディレクトリを上書きして修復しない。

## logs/ — agent のセッションログ

agent ごと・セッションごとに `logs/<year>/<month>/<day>/<agent_name>/<session_id>/` へ記録する。
セッション内の作業は `index.md` にまとめ、個別の判断や成果物は同じディレクトリに置く。
人間用の `mine/` はこの構成に含めない。

初回は `pnpm install` で型チェック・テスト用の依存を入れる (サブコマンド自体は Node.js 24 だけで動く)。

```sh
pnpm log:create codex                          # 当日・UUID を自動採番
pnpm log:create claude --session <session_id>  # 既存セッションなら開始日のパスを再利用
```

詳細は [logs/README.md](logs/README.md) を参照。

## docs/ — プロジェクト関連ドキュメント

後から参照するドキュメントの保管場所。一般資料は**公式性のレベルで3つに分け**、
Gherkinの仕様・手順書は `feature/` に置く。

| ディレクトリ | 置くもの |
| --- | --- |
| `feature/` | Gherkinの `.feature`。現行仕様と `archived/` を管理 |
| `official/` | 顧客・発注元・社内で正式に合意または承認されたもの (要件定義、仕様書、契約、規約) |
| `unofficial/` | 共有はするが正式な承認は無いもの (議事メモ、調査結果、設計の下書き) |
| `personal/` | 自分だけが使うもの (作業メモ、手順の覚書) |

判断に迷ったら **「他人がこれを根拠に判断してよいか」** で切り分ける。
各分類の下は案件ごとに切り、ディレクトリ名は `jobs/<案件名>/` と揃える。
案件に紐づかないものは `common/` に置く。

```sh
mkdir -p docs/official/acme-site
```

`logs/` が agent のセッション記録、`docs/` が継続的に参照するドキュメントという違いで使い分ける。
詳細は [docs/README.md](docs/README.md) を参照。

運用ルールの入口を短く保つため、**`docs/README.md` は上限 800 トークン (警告 600)** とする。
超えた場合は個別の事情を削り、分類と判断基準を残す。

```sh
./.claude/skills/reload-project/count_tokens.sh docs/README.md
```

## scripts/ — 管理操作の実装とサブコマンド

案件・タスク・QA・セッションログ・関連リポジトリの操作は `scripts/` の TypeScript にまとめてある。
Node.js 24 が `.ts` を直接実行するのでビルドは不要。処理の実体はこのリポジトリと一緒に版管理する。

```text
scripts/
├── cli.ts              # サブコマンドの共通入口
├── package.json        # 管理形式の識別情報 (raprid.format / raprid.protocol) と "type": "module"
├── commands/           # job・task・qa・log・repo・migrate
├── lib/                # frontmatter・索引・ロック・Markdown の共通処理
├── templates/          # 案件・タスク・詳細・QA・セッションログ・repos 管理文書の雛形 (唯一の複製元)
└── test/               # node:test (pnpm test)
```

呼び出し方は 3 通りあり、どれも同じ `scripts/cli.ts` を実行する。

```sh
raprid task list PROJ-123              # グローバルの raprid CLI (管理リポジトリの scripts/ に委譲する)
pnpm raprid task list PROJ-123         # CLI を入れていない環境
node scripts/cli.ts task list PROJ-123 # pnpm も無い環境
```

| コマンド | 内容 |
| --- | --- |
| `raprid job create <案件名>` | `scripts/templates/job/` から `jobs/<案件名>/` を作る。既存の案件は上書きしない |
| `raprid job migrate [--dry-run \| --apply \| --restore <ID>]` | 旧構成 (`job/`) からの移行。「[旧構成からの移行](#旧構成からの移行)」を参照 |
| `raprid task add <案件名> <タスク名> <状態> <タイトル> [blockedBy]` | タスクを追加する (固定 ID を採番し、実体と状態索引を作る) |
| `raprid task list [<案件名>]` | 状態別の一覧。ID の重複・索引の不一致も報告する |
| `raprid task move <案件名> <ID\|名前> <状態> [blockedBy]` | 状態・日付・依存関係と状態索引を一緒に更新する |
| `raprid task note <案件名> <ID\|名前> <詳細名> [<見出し>]` | 詳細 md を連番で作り、`index.md` の「## 詳細」からリンクする |
| `raprid qa add <案件名> <QA名> <確認先> <質問内容> [blockedBy]` | QA を追加する |
| `raprid qa list [<案件名>]` | 未解決・解決済みの一覧 |
| `raprid qa resolve <案件名> <ID\|名前> <回答>` | 回答を記入して resolved にする |
| `raprid qa move <案件名> <ID\|名前> unresolved` | 再オープンする (回答は残す) |
| `raprid log create <agent名> [--date] [--session]` | セッションログを作る (`pnpm log:create` も同じ) |
| `raprid repo add <URL> [--dir-name <名前>] <権限>` | submodule と管理文書を追加する |
| `raprid repo setup-worktrees <名前> [ブランチ ...]` | `repo/` を `local/verification` にし、`.worktrees/` に展開する |

終了コードは 0 成功 / 1 操作の失敗 / 2 引数の誤り。各 group の詳細は `raprid <group> --help` で表示する。

`raprid` CLI は、カレントディレクトリから上へ `scripts/package.json` (`raprid.protocol` を持つもの) と
`scripts/cli.ts` がそろったディレクトリを探し、最も近いものを管理リポジトリのルートとする。
Git リポジトリの境界 (`.git` のあるディレクトリ) より上は探さないので、submodule の中から親の管理リポジトリを
誤って操作することはない。CLI が対応していない `protocol` の場合は、CLI かプロジェクトの `scripts/` の
どちらを更新すべきかを表示して終了する (終了コード 1)。

`scripts/` 自身の変更は通常のコード変更と同じくテストしてからコミットする (`pnpm typecheck`、`pnpm test`)。
スキル付属の補助スクリプト (`count_tokens.sh` など) はスキルの中に置き、`scripts/` には移さない。

## jobs/ — 案件・タスク管理

案件は `raprid job create <案件名>` で作る。案件番号に紐づかないタスクや QA は `jobs/other/` に置き、
`common` など別名の受け皿を増やさない。

```text
jobs/acme-site/
├── MEMORY.md                        # 案件のトピック MEMORY (reload-project が生成)
├── tasks/                           # タスクの実体。1 タスク = 1 ディレクトリ
│   └── api-setup/
│       ├── index.md                 # frontmatter と要約 (タイトル・内容・完了条件・詳細へのリンク・結果)
│       ├── 01-investigation.md      # フェーズ・調査ごとの詳細 (計画・実施内容・判断)
│       ├── 02-implementation.md
│       └── assets/                  # このタスクの成果物とテスト結果
│           ├── retry-behavior.mov
│           └── 2026-01-15/          # テストの実行単位 (GIF と結果)
│               ├── result.md
│               └── P-1-1-....gif
├── status/                          # タスクの状態索引
│   ├── todo/
│   ├── pending/
│   ├── progress/
│   │   └── api-setup -> ../../tasks/api-setup
│   └── done/
├── qa/                              # QA の実体。1 QA = 1 ディレクトリ
│   ├── deployment-policy/
│   │   ├── index.md                 # frontmatter・質問・回答
│   │   └── current-flow.png         # 質問の資料
│   └── status/
│       ├── unresolved/
│       │   └── deployment-policy -> ../../deployment-policy
│       └── resolved/
└── assets/                          # 案件共通の補助ツール (Playwright の e2e/ など) だけを置く
```

### タスクの管理方式

**タスクの実体は `tasks/<タスク名>/` に置く。** `status/` の `todo/` `pending/` `progress/` `done/` には
タスクのディレクトリを指す**相対パスのシンボリックリンク** (`../../tasks/<タスク名>`) を置く。

* `index.md` はタスクの**要約**。frontmatter・タイトル・内容・完了条件・「## 詳細」(詳細 md へのリンク)・結果を書く。
  一覧や MEMORY の生成はここだけを読む。
* 詳細 md はフェーズや調査ごとに 1 ファイル (`<連番2桁>-<英小文字とハイフン>.md`)。
  計画・実施内容・判断を書く。`raprid task note` が `scripts/templates/task/_.md` を複製し、
  `index.md` の「## 詳細」にリンクを追加する。
* `assets/` はそのタスクの結論の根拠になる成果物とテスト結果。`index.md` からは `assets/<ファイル名>` で参照する。
  テストの実行結果は、同じタスクを何度も回すため **`assets/<実行日>/`** と実行単位で切る
  ([docs/feature/README.md](docs/feature/README.md) の証跡ルールを参照)。
  調査の途中経過や、その日の作業に属するものは
  `logs/<year>/<month>/<day>/<agent_name>/<session_id>/outputs/` に置く。

**状態の正は `index.md` の frontmatter にある `status`。** `status/{todo,pending,progress,done}/` の
リンクは、`ls` で状況を見るための**索引**として置く。
両者が食い違ったときは frontmatter を信じる (リンクの張り替え漏れとして扱う)。

frontmatter を正にしているのは、**リンクの位置では表現できない情報**
(いつ作ったか、いつ更新したか、何を待っているか) を同じ場所に置きたいため。
状態だけを別の場所で管理すると、状態と日付を突き合わせるのに 2 箇所を見る必要が出る。

リンク先を `../../tasks/<タスク名>` という相対パスにしているため、
`todo/` `pending/` `progress/` `done/` はいずれも `status/` 直下で同じ深さにあり、
`mv` で移動してもリンクは壊れない。ファイル名に ID は付けない (ID は frontmatter が持つ)。

### 状態の意味

| 状態 | 意味 |
| --- | --- |
| `todo` | **今すぐ着手できる。** 判断も材料も揃っていて、あとは手を動かすだけ |
| `pending` | **外部要因で着手できない。** 回答・判断・先行タスク・手段の確保を待っている |
| `progress` | 着手中 |
| `done` | 完了 |

`todo` と `pending` を分けるのは、**`status/todo/` を「次にやる作業の候補リスト」として
そのまま使えるようにする**ため。待ちのタスクが混ざっていると、
一覧を見るたびに「これは今できるのか」を各ファイルを開いて判断し直すことになる。

**`pending` にするときは `blockedBy` に待っている相手を必ず書く**
(QA でもタスクでもない待ちは `other: <何を待っているか>`。下の frontmatter の節を参照)。
何を待っているかを書けないなら、それは `pending` ではなく
`todo` (単に優先度が低い) か、そもそもタスクとして成立していない。
待ちが解けたら `todo` (または直接 `progress`) へ戻し、`blockedBy` を空にする。

### 操作手順

```sh
raprid job create acme-site                                   # 案件を作る
raprid task add acme-site api-setup todo "API を用意する"      # T-001 を採番し、status/todo/ に索引を張る
raprid task note acme-site T-001 investigation "既存 API の調査" # 01-investigation.md を作り index.md からリンク
raprid task move acme-site T-001 progress                     # 着手する
raprid task move acme-site T-001 pending qa/Q-001             # 待ちが発生した (blockedBy が必須)
raprid task move acme-site T-001 todo                         # 待ちが解けた (blockedBy を空にする)
raprid task move acme-site T-001 done                         # 完了する (completedAt を記入)
raprid task list acme-site                                    # 一覧と不一致の報告
```

追加コマンドは既存案件だけを対象とし、実体と状態索引を同時に作る。タスクの初期状態は
`todo`、`progress`、`pending`で、`pending`では5番目の`blockedBy`が必須。
状態変更は frontmatter の `status`・`updatedAt`・`completedAt`・`blockedBy` と状態索引を一緒に更新し、
未知の項目・コメント・本文は変更しない。途中で失敗した場合は、その実行で変えたものだけを戻す。
採番・状態変更・詳細の追加は案件単位で排他する (`jobs/.locks/`、Git 管理外)。
frontmatter が対応外の書式 (入れ子の値など) の場合は推測で書き換えずに停止する。

タスクには案件内で固定の`T-001`形式、QAには`Q-001`形式のIDをfrontmatterへ持たせる。
追加時は既存IDの最大値＋1を自動採番する。実体は削除せず、廃止時も記録として残す運用とし、欠番は埋めない。
一覧ではIDを表示し、状態変更はIDを優先して検索する。ディレクトリ名による指定もできる。

### タスクの index.md

frontmatter + 本文 (タイトル / 内容 / 完了条件 / 詳細 / 結果)。雛形は `scripts/templates/task/index.md`。

```yaml
---
id: T-001                                     # 案件内で固定のタスクID
status: progress                              # todo | pending | progress | done ← 状態の正
createdAt: 2026-01-15                         # 作成日
updatedAt: 2026-01-15                         # 最終更新日
completedAt:                                  # done にした日 (未完了なら空)
blockedBy:                                    # 先に片付かないと進めないもの
  - qa/Q-001                                  # qa/Q-001 または task/T-001
test:                                         # 対応する手動テストの手順書
  - docs/feature/admin/item-edit/               # docs/feature/ 配下のファイルかディレクトリ
---
```

日付はすべて `YYYY-MM-DD`。値が無いものはキーだけ残して空にする
(キーを消すと、書き忘れなのか該当なしなのか区別できない)。

`blockedBy`は`qa/Q-001`で同じ案件のQAを、`task/T-001`で同じ案件のタスクを指す。
別案件のQAを指す場合は`qa/<案件名>/Q-001`と書く。既存のファイル名による指定も読めるが、
新規・更新時は固定IDを使う。
**どちらでもない待ち** (権限や手段の確保、起票していない確認など) は
`other: <何を待っているか>` と書く。
`other:` が続くようなら、それは QA として起票した方がよい合図。
待っているものが複数あるときは、**進行を妨げている主なものだけ**を書き、
全体は本文に書く (ここは索引であって議論の場ではない)。
依存関係の意味や状態への連動は拡張していない (`blockedBy` は記録と索引)。

**`status: pending` のタスクは `blockedBy` が空であってはならない。**
逆に `blockedBy` が埋まっていても、着手できるなら `todo` のままでよい
(参考情報としての依存関係もあるため)。

`test` は手動テストの手順書 (`docs/feature/` 配下の `.feature`) を指す。
ディレクトリを書いた場合は、その中の `_` で始まらない feature を名前順に全部指す。
手順書側のシナリオ ID (`@P-1-1`) と `## 完了条件` のチェックは 1:1 で対応させる。
実行は `/verify-task` か `/run-manual-test` で行い、結果と GIF は
`tasks/<タスク名>/assets/<実行日>/` に残る。詳細は [docs/feature/README.md](docs/feature/README.md) を参照。

## jobs/<案件名>/qa/ — 質問と回答

質問と回答を案件ごとに1件1ディレクトリで記録する。タスクと同じ方式で、
**実体は `jobs/<案件名>/qa/<QA名>/index.md` に置き、`qa/status/unresolved/` と
`qa/status/resolved/` には QA のディレクトリを指す相対シンボリックリンク (`../../<QA名>`) を置く。**
質問の資料 (画面の画像や抜粋) は同じディレクトリに置く。
特定案件に属さないものは `jobs/other/qa/` に置く。`status` は索引のディレクトリ名なので QA 名に使えない。

```sh
raprid qa add acme-site deployment-policy customer "本番反映の手順はこれでよいか"
raprid qa resolve acme-site Q-001 "確認環境から実行する"   # 回答欄の先頭に追記し resolved にする
raprid qa move acme-site Q-001 unresolved                 # 再オープンする (回答は残す)
raprid qa list acme-site
```

### QA の index.md

frontmatter + 本文 (質問内容 / 回答内容)。雛形は `scripts/templates/qa/index.md`。

```yaml
---
id: Q-001                                     # 案件内で固定のQA ID
status: unresolved                            # unresolved | resolved ← 状態の正
createdAt: 2026-01-15                         # 起票日
updatedAt: 2026-01-15                         # 最終更新日
resolvedAt:                                   # 解決した日 (未解決なら空)
job: acme-site                                # 親の jobs/<案件名>/ と一致させる
askTo: customer                               # customer | internal | undecided
blockedBy: []                                 # 先に決まらないと判断できないもの
---
```

`askTo` は誰に聞くか。`customer` は発注元・顧客への確認、`internal` は社内で
判断できるもの、`undecided` は仕分け前。会議の準備をするとき、
**顧客に持っていく分だけを抜き出せる**ようにするためのフィールド。

**未解決かどうかは frontmatter の `status` で判断する。**
`qa/status/unresolved/` のリンクは索引で、「## 回答内容」が空かどうかでも判断しない
(回答が来る前に検討メモを書くことがあるため)。

## 旧構成からの移行

旧構成 (`job/<案件名>/list/<タスク名>.md`、`job/<案件名>/qa/list/`、案件直下の `assets/<タスク名>/`、
`job/*.sh`) のプロジェクトは `raprid job migrate` で新構成へ移す。`scripts/` の無い旧プロジェクトでも、
配布された raprid CLI が同梱の移行処理で開始し、移行と同時に `scripts/` を導入する。

```sh
raprid job migrate --dry-run                 # 旧→新のパス対応・衝突・書き換えるリンク・保留項目を表示 (既定)
raprid job migrate --apply --plan <ハッシュ> # 表示した計画と一致する場合だけ実行する
raprid job migrate --restore <移行ID>        # 移行前の状態に戻す
```

* 作業ツリーの内容 (未コミットの変更を含む) を入力にする。事前にコミットしておくと差分を確認しやすい。
* タスクの「## ログ」はフェーズ (`###`) ごとの詳細 md に分け、`index.md` の「## 詳細」からリンクする。
  コードブロック内の見出しは区切りにしない。フェーズ見出しの無いログは `01-log.md` に原文のまま保存して報告する。
  省くのは雛形の骨組み (計画・実施内容・判断・結果の見出しだけ) のフェーズだけで、見出しに記録があるものは残す。
  詳細 md の名前は英数字だけの見出しならその英小文字、日本語を含む見出しは `phase<連番>` にする。
* `assets/<タスク名>/` はタスク内の `assets/` へ移し、タスク名と一致しない資料は案件共通の `assets/` に残す。
* frontmatter (固定 ID・状態・日付・`blockedBy`・`test`・未知の項目) は変更しない。
  状態索引は frontmatter の `status` から作り直し、旧索引の不一致は一覧で報告する。
  ID の重複や分類できないファイルがあれば何も変更せずに中止する。
* Markdown のリンク (本文・詳細・QA 資料・docs・日報・MEMORY) は移動先に合わせて書き換える。
  本文中のコマンド例や引用の旧パスは歴史的記録として書き換えず、残っている文書を一覧する。
  旧ツリーに実在しないリンク先 (プレースホルダ・脚注など) は変えない。HTML の `src`/`href` と、
  分割で別ファイルに移りうる同じファイル内のアンカーは書き換えず、保留として一覧する。
* 変更する既存ファイルと旧 `job/` は `.raprid-migrate/<移行ID>/backup/` に退避し、手順を `journal.json` に記録する。
  途中で失敗した場合はその実行で変えたものだけを戻す。移行後の再実行は何も変更しない。
  `--apply` と `--restore` は同じリポジトリで同時に動かないよう排他する。
  戻すときは、この移行で置いた内容と一致するものだけを戻し、移行後に手で変更されたものがあれば
  (記録が途中の状態でも) 何も戻さずに停止する。
* `package.json` には `scripts.raprid` だけを追加し (無ければ作る)、`.gitignore` の `job/` の行を `jobs/` に読み替える。
  旧 `job/*.sh` と旧雛形 (`template/`・`template.md`) は移さず、退避先にだけ残す。
* スキル・README・CLAUDE.md などの説明文は移行しない。一覧に出た文書は新しいコマンドに合わせて手で直す。
* 旧パス (`job/<案件>/list/<タスク>.md`) を直接読む外部ツールは移行後に動かなくなる。
  例: グローバルの Herdr multi-agent workflow (`~/.config/herdr/multi-agent/`) は旧パスのタスク md を参照するため、
  新構成に対応するまでは `--task` 指定を使わず、依頼文でタスクの `index.md` のパスを渡す。

## repos/ — 関連リポジトリ (submodule)

関連リポジトリごとにディレクトリを作る。`repo/` は `origin/main` から分岐した
`local/verification` を使うローカル動作確認用の作業ツリーとし、作業ブランチと使用する
リモートブランチは `.worktrees/<ブランチ名>/` に置く。
同じ階層の `MEMORY.md` は現在状態、`BRANCH.md` は Gherkin 形式のブランチ運用規約、
`WORKTREES.md` は配置・統合手順を保持する。
あわせて Claude Code / Codex 起動時の role ごとのアクセス権限を管理する。

```sh
raprid repo add <リモートリポジトリのssh経由URL> [--dir-name <ディレクトリ名>] <権限>
```

`repos/<名前>/{repo/,.worktrees/,MEMORY.md,BRANCH.md,WORKTREES.md}` の作成と、`repos/README.md` の
アクセス権限テーブルへの追記が同時に行われる。
詳細は [repos/README.md](repos/README.md) を参照。

## docs/feature/ — Gherkinの仕様・手動テスト手順

仕様と手動テストの手順を Gherkin 記法で書いて置く。**現在の仕様に合致しているものだけを
置き、古くなったら `archived/` に逃がす。**

```
docs/feature/
├── <領域>/<機能>/     # admin/item-edit/ のように機能ごとに切る
└── archived/          # 仕様が変わって使えなくなったもの (同じ相対パスで置く)
```

**`jobs/` の中ではなくここに置くのは、手順がタスクより長生きするため。**
タスクが `done` になっても仕様は残り、次の案件で同じ画面をテストするときに使える。

1 ファイル = 1 `Feature:` = 1 章とし、**中身は最小限にして章ごとに分ける**。
ファイル名は `<章番号 2 桁>-<内容>.feature`。`_` で始まるファイルは実行対象にせず、
同じディレクトリ共通の `Background:` と共通操作を置く。

| 使うもの | やること |
| --- | --- |
| `/verify-task` | 手順を対話で提示し、人が実機を見て結果を選ぶ |
| `/run-manual-test` | 手順をブラウザで実行し、シナリオごとに証跡を残す |
| 案件固有の実行コード | 必要なら `jobs/<案件名>/assets/e2e/` に置き、feature の写しとして管理する |

案件固有の spec を作る場合も **`.feature` が正で、spec は手順書の写し**とする。
spec には `@P-2-1` のようなシナリオ ID を test title に埋め、1:1 で対応させる。

タスクとの対応は frontmatter の `test:`、結果と GIF は
`jobs/<案件名>/tasks/<タスク名>/assets/<実行日>/`。
背景情報 (画面構成図・ステータス値・データ準備 SQL) は `docs/unofficial/<案件名>/` 側に置く。
記法と運用の詳細は [docs/feature/README.md](docs/feature/README.md) を参照。

## MEMORY.md — プロジェクト状態のダイジェスト

現在の状況 (進行中の job、直近のセッションログ、未解決の QA、submodule 一覧) を要約したファイル。
`/reload-project` スキルが全体をスキャンして再生成する**自動生成物なので、手で編集しない**。
トップレベルの上限は 800 トークン、案件・領域の直下に置くトピック MEMORY は各 500 トークン。
生成と圧縮のルールは `.claude/skills/reload-project/SKILL.md` を参照。

## 空ディレクトリの扱い

git は空ディレクトリを追跡しないため、`outputs/` や `status/pending/` のように
中身が無い状態がありうるディレクトリには `.gitkeep` を置いている。
新しく同種のディレクトリを作る場合も `.gitkeep` を置くこと。
