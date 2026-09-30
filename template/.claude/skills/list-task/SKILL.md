---
name: list-task
description: jobs/ 配下のタスクを progress / todo (ready) / pending / done (closed) 別に一覧表示する。工程型タスクは種別・工程・担当を添え、案件名で絞り込み、待ちの理由と索引の不一致も報告する。タスク一覧や残作業を知りたいときに使う。参照のみで状態は変更しない。
---

# list-task

先に [共通実行ルール](../runtime.md) を読む。
タスクの状態は `jobs/<案件名>/tasks/<名前>/index.md` の frontmatter が正。
旧形式は `status`、工程型 (`workflowVersion: 3`) は `status` (open / closed)・`phase`・`workflow.<工程>.status`。
`status/{todo,pending,progress,done}/` (旧形式) と `status/<工程>/<工程の状態>/` (工程型) の相対リンクは索引であり、一覧の集計元にはしない。

## 対象と読み方

案件名の指定があれば絞る。完全一致を優先し、部分一致で複数残るときだけ確認する。
省略時は全案件。既定では done は件数のみ、完了タスクの指定があれば全件表示する。

まず `raprid task list [<案件名>] --all --json --schema-version 2` (CLI が無ければ `pnpm raprid ...` か `node scripts/cli.ts ...`) を使う。
`items` (状態・待ちの相手・actor・日付。工程型は `workflowVersion`・`type`・`phase`・`phaseStatus`・`assignee`)、`counts`、
`issues` (ID と索引の不一致など) を JSON で得られる。`--schema-version 2` を付けないと、工程型タスクのある案件は
`SCHEMA_V2_REQUIRED` で止まる (旧形式だけの古い scripts/ は `--schema-version` を知らないので、そのときは付けずに読む)。
工程の絞り込みは `--type research|implementation`・`--phase <工程>`・`--assignee <actor>`・`--status ready,progress`。
人に見せる一覧は `raprid task list [<案件名>]` (既定は done 以外。`--all` で全件、`--long` で actor と日付) でもよい。
不整合は末尾の「要確認」にまとまる。1 件の詳細は `raprid task show <案件名> <ID> [--json]`。
表示の文字列は整形のため変わりうるので、機械的に読むときは表示ではなく `--json` を使う。
コマンドが使えない場合は実体を直接読む。

```sh
find jobs -path '*/tasks/*/index.md' -not -path 'jobs/.*' | sort
```

- 各実体の先頭の `---` に挟まれた YAML を読み、`id` / `status` / `blockedBy` / `requestedBy` / `createdBy` / 日付を取得する。
  本文のサンプル YAML は対象にしない。詳細 md (`01-*.md` など) は集計しない。
- `blockedBy: [qa/Q-001]` と複数行のリストをどちらも読む。
  `other: <待っているもの>` の形式も有効。1 種類の書式だけを拾う awk で空と判定しない。
  `qa/Q-001`は同じ案件、`qa/<案件名>/Q-001`は別案件のQAを指す。従来のファイル名形式も読む。
- タイトルは「## タイトル」の先頭の非空行から取得する。無ければタスクのディレクトリ名を表示する。
- 一覧には案件内で固定の`T-001`形式のIDを表示する。日常操作ではファイル名よりIDを優先する。
- 表示順は progress → todo → pending → done。pending には必ず待っている相手を添える。
  工程型は工程の状態で並べ (ready は todo、closed は done の位置)、種別・工程・担当を添える。
  closed は `closureReason` が legacy_done (移行した旧 done) か accepted (人の受入済み) かを区別する。
  受入確認 (`acceptance`) を待つものは、担当の人を添えて分かるようにする (AI が受け入れたとは書かない)。
- 状態変更を依頼された場合は [task-transition](../task-transition/SKILL.md) を使う。

## 索引を検証する

一覧を作った後で `status/{todo,pending,progress,done}/` を調べる。
実体の状態に関係なく、以下を「要確認」として報告する。参照依頼では修復しない。

- `status` が未記入・未知の値、pending なのに `blockedBy` が空。
- `id`が未記入・`T-001`形式でない・同じ案件内で重複している。
- 実体に対応するリンクが無い、または複数の状態ディレクトリにある。
- リンク先が `../../tasks/<同名>` ではない、リンク切れ、索引にリンク以外が置かれている、実体の無い索引。
- リンクの置き場所と実体の `status` が一致しない。工程型は作業索引が今の工程・状態と違う、複数ある、closed なのに残っている。
- 工程型なのに読めない・検証に失敗する (`valid: false`・`readable: false`)。workflowVersion 2 (移行が必要)。
- `blockedBy` のQAが存在しない、またはQAが `resolved` なのにタスクが `pending` のまま。

リンクの無い実体も一覧に含める。状態不明は勝手に todo とせず別に示す。
壊れたリンクは `test -e` だけでは拾えないので `test -L` / `readlink` も使う。
シェルで未一致の glob を回す例は Bash で実行するか、`find` で列挙する。

## 報告例

```text
PROJ-123 (jobs/PROJ-123/)
  progress (1)
    playwright-e2e-setup   Playwright の導入
  todo (1)
    item-update-optimistic-lock   項目更新の楽観ロック
  pending (1)
    T-016  guard-exception-status   ガードの例外応答 ← qa/Q-004
  done: 29 件

要確認:
  索引の不一致: example (索引: todo, status: progress)
```

案件ごとの件数と全案件の合計を添える。MEMORY・logs・タスクのファイルは変更しない。
