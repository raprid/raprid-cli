---
name: list-task
description: jobs/ 配下のタスクを progress / todo / pending / done 別に一覧表示する。案件名で絞り込み、待ちの理由と状態索引の不一致も報告する。タスク一覧や残作業を知りたいときに使う。参照のみで状態は変更しない。
---

# list-task

先に [共通実行ルール](../runtime.md) を読む。
タスクの状態は `jobs/<案件名>/tasks/<名前>/index.md` の frontmatter `status` が正。
`status/{todo,pending,progress,done}/` の相対リンクは索引であり、一覧の集計元にはしない。

## 対象と読み方

案件名の指定があれば絞る。完全一致を優先し、部分一致で複数残るときだけ確認する。
省略時は全案件。既定では done は件数のみ、完了タスクの指定があれば全件表示する。

まず `raprid task list [<案件名>]` (CLI が無ければ `pnpm raprid task list` か `node scripts/cli.ts task list`) を使う。
状態別の一覧・待ちの相手・ID と索引の不一致 (「要確認:」) をまとめて出力する。
コマンドが使えない場合や、日付など追加の項目が必要な場合は実体を直接読む。

```sh
find jobs -path '*/tasks/*/index.md' -not -path 'jobs/.*' | sort
```

- 各実体の先頭の `---` に挟まれた YAML を読み、`id` / `status` / `blockedBy` / 日付を取得する。
  本文のサンプル YAML は対象にしない。詳細 md (`01-*.md` など) は集計しない。
- `blockedBy: [qa/Q-001]` と複数行のリストをどちらも読む。
  `other: <待っているもの>` の形式も有効。1 種類の書式だけを拾う awk で空と判定しない。
  `qa/Q-001`は同じ案件、`qa/<案件名>/Q-001`は別案件のQAを指す。従来のファイル名形式も読む。
- タイトルは「## タイトル」の先頭の非空行から取得する。無ければタスクのディレクトリ名を表示する。
- 一覧には案件内で固定の`T-001`形式のIDを表示する。日常操作ではファイル名よりIDを優先する。
- 表示順は progress → todo → pending → done。pending には必ず待っている相手を添える。
- 状態変更を依頼された場合は [task-transition](../task-transition/SKILL.md) を使う。

## 索引を検証する

一覧を作った後で `status/{todo,pending,progress,done}/` を調べる。
実体の状態に関係なく、以下を「要確認」として報告する。参照依頼では修復しない。

- `status` が未記入・未知の値、pending なのに `blockedBy` が空。
- `id`が未記入・`T-001`形式でない・同じ案件内で重複している。
- 実体に対応するリンクが無い、または複数の状態ディレクトリにある。
- リンク先が `../../tasks/<同名>` ではない、リンク切れ、索引にリンク以外が置かれている、実体の無い索引。
- リンクの置き場所と実体の `status` が一致しない。

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
