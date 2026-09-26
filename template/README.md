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
├── package.json                 # pnpm スクリプト (log:create / test / typecheck)。Node.js 24 以上
├── tsconfig.json
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
│   ├── create_log.ts            # セッションログを作成する (pnpm log:create)
│   ├── create_log.test.ts       # 作成処理のテスト (pnpm test)
│   ├── template/
│   └── <YYYY>/<MM>/<DD>/<agent_name>/<session_id>/
├── docs/                        # プロジェクト関連ドキュメント
│   ├── README.md
│   ├── feature/                 # Gherkinの仕様・手動テスト手順
│   ├── official/                # 公式 (正式に合意・承認されたもの)
│   ├── unofficial/              # 非公式 (共有はするが未確定のもの)
│   └── personal/                # 個人 (自分だけが使うもの)
├── job/                         # 案件・タスク管理
│   ├── list-task.sh             # 案件別のタスク一覧
│   ├── list-qa.sh               # 案件別のQA一覧
│   ├── add-task.sh              # 既存案件へのタスク追加
│   ├── add-qa.sh                # 既存案件へのQA追加
│   ├── task-transition.sh       # タスク状態の変更
│   ├── qa-transition.sh         # QA状態の変更
│   ├── template/
│   ├── other/                   # 特定案件に属さないタスク・QA
│   └── <案件名>/
│       ├── list/                # タスクの実体
│       ├── assets/              # タスクの成果物・案件固有の補助ツール
│       ├── status/{todo,pending,progress,done}/ # タスクの状態索引
│       └── qa/
│           ├── list/            # QA の実体
│           └── status/{unresolved,resolved}/   # QA の状態索引
├── repos/                       # 関連リポジトリ (submodule)
│   ├── README.md
│   ├── add_submodule.sh
│   └── <リポジトリ名>/
│       ├── repo/                # ローカル動作確認用 worktree
│       ├── .worktrees/          # 作業・リモートブランチ用 worktree（Git 管理外）
│       ├── MEMORY.md            # 現在のブランチ・HEAD・作業ツリー
│       ├── BRANCH.md            # Gherkin 形式のブランチ運用規約
│       └── WORKTREES.md         # worktree の配置・統合手順
```

各ディレクトリの `template/` `template.md` は複製元であり、直接編集しない。
テンプレート自体のルールを変えたいときだけ編集する。

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

初回は `pnpm install` で型チェック・テスト用の依存を入れる (`log:create` 自体は Node.js 24 だけで動く)。

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
各分類の下は案件ごとに切り、ディレクトリ名は `job/<案件名>/` と揃える。
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

## job/ — 案件・タスク管理

案件ごとに `job/template/` を複製する。

```sh
cp -R job/template job/acme-site
```

案件番号に紐づかないタスクや QA は `job/other/` に置き、`common` など別名の
受け皿を増やさない。

### タスクの管理方式

タスクの**実体は常に `list/` に置く**。`status/` の `todo/` `pending/` `progress/` `done/` には
`list/` の実体を指す**相対パスのシンボリックリンク**を置く。

```
job/acme-site/
├── list/                      # タスクの実体はここだけ
│   ├── template.md            # タスク計画テンプレート
│   └── api-setup.md
├── assets/                    # タスクに紐づく成果物 (録画・画像・ログ)
│   └── api-setup/
│       ├── retry-behavior.mov
│       └── 2026-01-15/        # テストの実行単位 (GIF と結果)
│           ├── result.md
│           └── P-1-1-....gif
└── status/                    # frontmatter を一覧するための索引
    ├── todo/
    ├── pending/
    ├── progress/
    │   └── api-setup.md -> ../../list/api-setup.md
    └── done/
```

`assets/` はタスク名のディレクトリを切って中に置き、**タスクファイルから
相対リンクで参照する** (`../assets/<タスク名>/<ファイル名>`)。
実体が `list/` にあるので、リンクは `../assets/...` になる。
テストの実行結果は、同じタスクを何度も回すため
**`<タスク名>/<実行日>/` とさらに実行単位で切る**
([docs/feature/README.md](docs/feature/README.md) の証跡ルールを参照)。
調査の途中経過や、その日の作業に属するものは
`logs/<year>/<month>/<day>/<agent_name>/<session_id>/outputs/` に置く。
**タスクの結論の根拠になるものだけ** `assets/` に置く。

**状態の正は実体の frontmatter にある `status`。** `status/{todo,pending,progress,done}/` の
リンクは、`ls` で状況を見るための**索引**として置く。
両者が食い違ったときは frontmatter を信じる (リンクの張り替え漏れとして扱う)。

frontmatter を正にしているのは、**リンクの位置では表現できない情報**
(いつ作ったか、いつ更新したか、何を待っているか) を同じ場所に置きたいため。
状態だけを別の場所で管理すると、状態と日付を突き合わせるのに 2 箇所を見る必要が出る。

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
# 1. タスクを作成する (実体は list/)
cp job/acme-site/list/template.md job/acme-site/list/api-setup.md
#    frontmatter の status / createdAt / updatedAt を埋める

# 2. todo に登録する (相対パスのシンボリックリンク)
ln -s ../../list/api-setup.md job/acme-site/status/todo/api-setup.md

# 3. 着手する: todo -> progress
mv job/acme-site/status/todo/api-setup.md job/acme-site/status/progress/
#    実体の status を progress、updatedAt を当日に書き換える

# 4. 完了する: progress -> done
mv job/acme-site/status/progress/api-setup.md job/acme-site/status/done/
#    実体の status を done、completedAt と updatedAt を当日に書き換える

# (待ちが発生したとき) todo -> pending / progress -> pending
mv job/acme-site/status/todo/api-setup.md job/acme-site/status/pending/
#    実体の status を pending にし、blockedBy に待っている相手を書く

# (待ちが解けたとき) pending -> todo
mv job/acme-site/status/pending/api-setup.md job/acme-site/status/todo/
#    実体の status を todo にし、blockedBy を空にする
```

**状態を変えるときは frontmatter とリンクの両方を直す。**
リンクだけ動かして `status` が古いままだと、`list-task` が不一致として報告する。

リンク先を `../../list/<タスク名>.md` という相対パスにしているため、
`todo/` `pending/` `progress/` `done/` はいずれも `status/` 直下で同じ深さにあり、
`mv` で移動してもリンクは壊れない。

この方式により、

* タスクの内容・履歴・状態の参照先が `list/` の1ファイルに定まる
* 状態は `ls status/progress/` のようにディレクトリを見るだけでも分かる

### シェルで追加・一覧・状態変更する

案件名を指定すると、frontmatterの状態を正としてタスクとQAを操作できる。

```sh
./job/list-task.sh PROJ-123
./job/list-qa.sh PROJ-123

./job/add-task.sh PROJ-123 check-prod-data todo "本番データを確認する"
./job/add-qa.sh PROJ-123 correction-policy customer "補正方法はこの方針でよいか"

./job/task-transition.sh PROJ-123 T-001 progress
./job/task-transition.sh PROJ-123 T-001 pending qa/Q-001
./job/qa-transition.sh PROJ-123 Q-001 resolved "確認環境から実行する"
```

追加スクリプトは既存案件だけを対象とし、実体と状態索引を同時に作る。タスクの初期状態は
`todo`、`progress`、`pending`で、`pending`では5番目の`blockedBy`が必須。QAは`unresolved`で作成し、
確認先には`customer`、`internal`、`undecided`のいずれかを指定する。
状態変更スクリプトはfrontmatterの日付・完了日・依存関係と状態索引を一緒に更新する。
QAを`resolved`へ変更するときは、既存メモを残したまま回答欄の先頭へ追加する1行の回答が必要になる。

タスクには案件内で固定の`T-001`形式、QAには`Q-001`形式のIDをfrontmatterへ持たせる。
追加時は既存IDの最大値＋1を自動採番する。実体は削除せず、廃止時も記録として残す運用とし、欠番は埋めない。
一覧ではIDを表示し、状態変更はIDを優先して検索する。既存のファイル名による指定も後方互換として利用できる。

### タスクファイルの中身

frontmatter + 本文 (タイトル / 内容 / 完了条件 / ログ (フェーズごとの計画と実施内容) / 結果)。

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

**`status: pending` のタスクは `blockedBy` が空であってはならない。**
逆に `blockedBy` が埋まっていても、着手できるなら `todo` のままでよい
(参考情報としての依存関係もあるため)。

`test` は手動テストの手順書 (`docs/feature/` 配下の `.feature`) を指す。
ディレクトリを書いた場合は、その中の `_` で始まらない feature を名前順に全部指す。
手順書側のシナリオ ID (`@P-1-1`) と `## 完了条件` のチェックは 1:1 で対応させる。
実行は `/verify-task` か `/run-manual-test` で行い、結果と GIF は
`assets/<タスク名>/<実行日>/` に残る。詳細は [docs/feature/README.md](docs/feature/README.md) を参照。

## job/<案件名>/qa/ — 質問と回答

質問と回答を案件ごとに1件1ファイルで記録する。タスクと同じ方式で、
**実体は `job/<案件名>/qa/list/` に置き、`qa/status/unresolved/` と
`qa/status/resolved/` には相対シンボリックリンクを置く。**
特定案件に属さないものは `job/other/qa/` に置く。

```
job/acme-site/qa/
├── list/                        # QA の実体はここだけ
│   └── deployment-policy.md
└── status/
    ├── unresolved/
    │   └── deployment-policy.md -> ../../list/deployment-policy.md
    └── resolved/
```

### 操作手順

```sh
# 1. QA を作成する (実体は list/)
cp job/template/qa/list/template.md job/acme-site/qa/list/deployment-policy.md
#    frontmatter の status / createdAt / updatedAt / job / askTo を埋める

# 2. 未解決として登録する (相対パスのシンボリックリンク)
ln -s ../../list/deployment-policy.md job/acme-site/qa/status/unresolved/deployment-policy.md

# 3. 解決したら: unresolved -> resolved
mv job/acme-site/qa/status/unresolved/deployment-policy.md job/acme-site/qa/status/resolved/
#    実体の status を resolved、resolvedAt と updatedAt を当日に書き換える
```

### QA ファイルの中身

frontmatter + 本文 (質問内容 / 回答内容)。

```yaml
---
id: Q-001                                     # 案件内で固定のQA ID
status: unresolved                            # unresolved | resolved ← 状態の正
createdAt: 2026-01-15                         # 起票日
updatedAt: 2026-01-15                         # 最終更新日
resolvedAt:                                   # 解決した日 (未解決なら空)
job: acme-site                                # 親の job ディレクトリ名と一致させる
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

## repos/ — 関連リポジトリ (submodule)

関連リポジトリごとにディレクトリを作る。`repo/` は `origin/main` から分岐した
`local/verification` を使うローカル動作確認用の作業ツリーとし、作業ブランチと使用する
リモートブランチは `.worktrees/<ブランチ名>/` に置く。
同じ階層の `MEMORY.md` は現在状態、`BRANCH.md` は Gherkin 形式のブランチ運用規約、
`WORKTREES.md` は配置・統合手順を保持する。
あわせて Claude Code / Codex 起動時の role ごとのアクセス権限を管理する。

```sh
./repos/add_submodule.sh <リモートリポジトリのssh経由URL> [--dir_name <ディレクトリ名>] <権限>
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

**`job/` の中ではなくここに置くのは、手順がタスクより長生きするため。**
タスクが `done` になっても仕様は残り、次の案件で同じ画面をテストするときに使える。

1 ファイル = 1 `Feature:` = 1 章とし、**中身は最小限にして章ごとに分ける**。
ファイル名は `<章番号 2 桁>-<内容>.feature`。`_` で始まるファイルは実行対象にせず、
同じディレクトリ共通の `Background:` と共通操作を置く。

| 使うもの | やること |
| --- | --- |
| `/verify-task` | 手順を対話で提示し、人が実機を見て結果を選ぶ |
| `/run-manual-test` | 手順をブラウザで実行し、シナリオごとに証跡を残す |
| 案件固有の実行コード | 必要なら `job/<案件名>/assets/e2e/` に置き、feature の写しとして管理する |

案件固有の spec を作る場合も **`.feature` が正で、spec は手順書の写し**とする。
spec には `@P-2-1` のようなシナリオ ID を test title に埋め、1:1 で対応させる。

タスクとの対応は frontmatter の `test:`、結果と GIF は
`job/<案件名>/assets/<タスク名>/<実行日>/`。
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
