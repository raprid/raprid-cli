# CLAUDE.md

プロジェクト管理リポジトリ。agent のセッションログ (`logs/`)、案件・タスク・Q&A (`jobs/`)、
ドキュメントと手動テストの手順書 (`docs/`)、関連リポジトリ (`repos/`) を管理する。

Codex の入口は [AGENTS.md](AGENTS.md)。共通ルールは README.md とこのファイルで共有し、
ツールの読み替えは [.claude/skills/runtime.md](.claude/skills/runtime.md) にまとめる。
スキルの実体は `.claude/skills/` に置き、Codex は `.agents/skills` のリンクから読む。

## 構成と運用ルール

ディレクトリ構成・命名・タスクの状態遷移などのルールは [README.md](README.md) にまとめてある。
**ファイルやディレクトリを追加・移動する前に必ず README.md を読み、記載された手順とサブコマンドを使うこと。**
雛形 (`scripts/templates/`) は複製元なので直接編集しない。
サブコマンドは `raprid <group> <command>`。CLI が無い環境では `pnpm raprid ...` か `node scripts/cli.ts ...` で同じ処理を呼べる。

よく使う操作:

| やること | 使うもの |
| --- | --- |
| agent のセッションログを作る | `raprid log create <agent名>` (`pnpm log:create <agent名>` も同じ) |
| 個別の作業記録を作る | セッション内の `_.md` を複製 ([logs/README.md](logs/README.md)) |
| 案件を始める | `raprid job create <案件名>` |
| 案件の一覧を見る | `raprid job list` |
| タスクを作る | `/add-task` または `raprid task add <案件> <名前> --type research\|implementation <タイトル>` |
| タスクのフェーズ・調査の記録を作る | `raprid task note <案件名> <ID> <詳細名>` |
| タスクの工程を進める | `/task-transition` または `raprid task claim\|complete\|decide\|block\|resume\|reopen\|assign` (旧形式は `raprid task move`) |
| タスクの状況を見る | `/list-task` または `raprid task list [<案件名>]` |
| 動作確認をする | `/verify-task` (手順を対話で提示し、結果を選択肢から選ぶ) |
| 手動テストを実行して GIF を撮る | `/run-manual-test` (Claude in Chrome で実行) |
| テストの手順書を置く | `docs/feature/<領域>/<機能>/` ([docs/feature/README.md](docs/feature/README.md)) |
| QA の状況を見る | `/list-qa` または `raprid qa list [<案件名>]` |
| QA を作る | `raprid qa add` |
| タスクから人へ質問する | `raprid task ask` (QA作成と `pending` 化を一体で行う) |
| QA を解決にする・再オープンする | `raprid qa resolve` / `raprid qa move <案件名> <ID> unresolved` |
| ドキュメントを置く | `docs/{official,unofficial,personal}/<案件名>/` ([docs/README.md](docs/README.md)) |
| リリース資料の変更箇所を作る | `/build-release-diff-sheet` (MR の差分を撮って貼る) |
| リリース資料の確認手順を作る | `/build-release-check-sheet` (`docs/feature/` の手順書から起こす) |
| submodule を追加する | `raprid repo add <URL> [--dir-name <名前>] <権限>` |
| 旧構成 (`job/`) から移行する | `raprid job migrate --dry-run` → `--apply` (README の「旧構成からの移行」) |
| 旧形式のタスクを工程型へ移す | `raprid job migrate-workflow --map <対応表>` → `--apply --plan <hash>` (README の「工程型への移行」) |
| プロジェクト状態を更新する | `/reload-project` |

submodule のローカル動作確認は `repos/<名前>/repo/`、作業ブランチは
`repos/<名前>/.worktrees/<ブランチ名>/` にある。作業前に同階層の `MEMORY.md` を読み、
ブランチの作成・切替・統合を伴う場合は `BRANCH.md` と `WORKTREES.md` も確認する。

## 手動テストの手順書

**手順は `docs/feature/<領域>/<機能>/` に Gherkin 記法で置く。タスク md には埋め込まない。**
手順はタスクより長生きするため、`done` になったタスクの中に埋まると再利用できない。

* 1 ファイル = 1 `Feature:` = 1 章。**中身は最小限にして章ごとに分ける**
* `_` で始まるファイルは実行対象にせず、ディレクトリ共通の `Background:` を置く
* 仕様が変わったら消さずに `docs/feature/archived/<同じ相対パス>` へ `git mv` する
* タスクとの対応はタスク md の frontmatter `test:` に書く
* 結果と GIF は `jobs/<案件名>/tasks/<タスク名>/assets/<実行日>/` に残し、タスクの `index.md` から参照する

実行は `/verify-task` (人が実機を見て結果を選ぶ) か
`/run-manual-test` (Chrome で実行してシナリオごとに GIF を撮る)。
詳細は [docs/feature/README.md](docs/feature/README.md) を参照。

## タスクと QA の状態

**新しいタスクは工程型 (workflowVersion 3) で作る。** 種別 (`type`: research / implementation) を必ず指定し、
工程は `plan` → `execute` → `review` → `acceptance`。今の工程は `phase`、工程の状態は `workflow.<工程>.status`
(`ready` / `progress` / `pending` / `waiting` / `done`)、タスク全体は `open` / `closed`。
工程は `raprid task claim`・`complete`・`decide`・`block`・`resume`・`reopen`・`assign` で進め (`--if-match` が必須)、
**`execute` を完了した actor は同じ成果物をレビューできない。受入確認は人 (`human/…`) だけが判定する。**
AI は完了や受入を自己宣言しない。作業索引は `status/<工程>/<工程の状態>/` に置く (closed は 0 件)。
詳細は README.md の「工程型タスク」。以下の旧形式の状態は、移行前のタスクにだけ使う。

**状態の正は実体 (`tasks/<タスク名>/index.md`、`qa/<QA名>/index.md`) の frontmatter にある `status`。**
`todo/` `pending/` `progress/` `done/` (タスク) と `unresolved/` `resolved/` (QA) に置く
シンボリックリンクは、`ls` で状況を見るための索引として扱う。
**`pending` は「外部要因で着手できない」状態**で、`blockedBy` に待っている相手を必ず書く
(`todo` は今すぐ着手できるもの)。
**状態を変えるときは frontmatter とリンクの両方を直す。**
食い違ったときは frontmatter が正で、リンクの張り替え漏れとして扱う。

frontmatter は固定ID (`T-001` / `Q-001`)、日付 (`createdAt` / `updatedAt` / `completedAt` / `resolvedAt`)、
依存関係 (`blockedBy`)、依頼元・記録者 (`requestedBy` / `createdBy`)、QA なら関連案件 (`job`)・確認先 (`askTo`)・
回答者 (`answeredBy`) を持つ。actor は `human/<識別子>` または `agent/<識別子>` で記録する。
項目の意味と書き方は [README.md](README.md) に従う。
QA は `jobs/<案件名>/qa/` に置き、特定案件に属さないものは `jobs/other/qa/` に置く。
タスクの `index.md` は要約とし、フェーズや調査ごとの計画・実施内容・判断は同じディレクトリの詳細 md に書く。

## agent の作業記録

**agent が行った作業は `logs/<year>/<month>/<day>/<agent_name>/<session_id>/` に記録する。**
agent 名は Claude Code なら `claude`、Codex なら `codex`、役割別 agent なら定義名を使う。

```sh
pnpm log:create claude                         # 新しいセッション (UUID を自動採番)
pnpm log:create claude --session <session_id>  # セッション ID が分かる場合・再開する場合
```

作成時に表示されたパスを、そのセッションの間使い続ける。日付をまたいでも開始日のディレクトリに書く。
人間の記録を置く場所ではない。
`index.md` はセッション全体、`_.md` の複製は個別作業、`outputs/` は一時成果物に使う。
詳細は [logs/README.md](logs/README.md) を参照。

## MEMORY.md の使い方

@MEMORY.md

`MEMORY.md` はプロジェクトの現在状況のダイジェスト。上のインポートによりセッション開始時に読み込まれる。
案件・領域で作業するときは、そのディレクトリ直下の `MEMORY.md` も読む。

* **状況把握の起点にする。** 進行中の job・直近のセッションログ・未解決の QA・submodule 一覧がまとまっている。
* **インデックスとして扱う。** 詳細が必要なときは MEMORY.md に書かれたパスから実ファイルを読む。
  MEMORY.md の記述だけで細部を判断しない。
* **手で編集しない。** `/reload-project` スキルがリポジトリ全体をスキャンして再生成する。
  個別の更新を書き足すのではなく、スキルを実行して作り直す。
* **記載が実態と食い違う場合は MEMORY.md ではなく実ファイルが正。** 読取依頼では差異を報告し、変更作業の区切りに `/reload-project` を実行する。

`/reload-project` を実行するタイミング:

* セッション開始時、MEMORY.md が古く、更新も依頼されているとき
* セッションログ・タスク・QA・submodule を追加/更新して作業に区切りがついたとき
* MEMORY.md の内容が古い、または実態と食い違うと気づいたとき

読み込み・一覧・相談だけの依頼では更新せず、実ファイルで裏取りして古い点を報告する。
変更作業では、その区切りに更新する。`@MEMORY.md` の展開が無い環境では明示的に読む。

サイズ上限は **800 トークン** (警告 600 トークン)。トピック MEMORY は各 **500 トークン** (警告 400 トークン)。
毎セッション読み込まれるため、上限を超える場合は古い情報から圧縮する。判定と圧縮のルールは
[.claude/skills/reload-project/SKILL.md](.claude/skills/reload-project/SKILL.md) に従う。

## 言語

ドキュメント・コメント・コミットメッセージは日本語で書く。
