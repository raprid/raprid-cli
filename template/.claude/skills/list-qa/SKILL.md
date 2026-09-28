---
name: list-qa
description: jobs/*/qa/ 配下の質問を案件・unresolved / resolved 別に一覧表示し、確認先・依存関係・索引の不一致を報告する。QA 一覧、未回答の質問、解決済みの QA を知りたいときに使う。参照のみで状態は変更しない。
---

# list-qa

先に [共通実行ルール](../runtime.md) を読む。
QA の状態は `jobs/<案件名>/qa/<名前>/index.md` の frontmatter `status` が正。
`qa/status/unresolved/` / `qa/status/resolved/` のリンクや、本文の回答欄が空かどうかでは決めない。

## 対象と読み方

- まず `raprid qa list [<案件名>] --all --json` (CLI が無ければ `pnpm raprid qa list ...`) で `items` と `issues` を得る。
  人に見せる一覧は `raprid qa list [<案件名>]` (既定は unresolved。`--all` で全件) で、不整合は末尾の「要確認」にまとまる。
  回答の全文は `raprid qa show <案件名> <ID> --json` の `item.answer`。
- 直接読む場合は `jobs/*/qa/<名前>/index.md` を列挙する (`qa/status/` は索引なので除く)。索引に無い実体も対象。
- キーワードがあればファイル名・質問内容で絞る。案件名や確認先の指定があれば
  親ディレクトリと frontmatter の `job` / `askTo` を使う。案件外は `other` とする。
- 先頭の YAML frontmatter から `id`、`status`、`job`、`askTo`、`blockedBy`、`requestedBy`、`createdBy`、`answeredBy` を読む。
  依存関係はインライン配列と複数行配列のどちらも扱う。
- frontmatter の `job` が親の `jobs/<案件名>/` と違う場合は不整合として報告する。
- 質問は「## 質問内容」から要約する。依頼元・記録者を表示し、解決済みの表示では「## 回答内容」と回答者も添える。
  空欄を推測で埋めない。
- 一覧には案件内で固定の`Q-001`形式のIDを表示する。日常操作ではファイル名よりIDを優先する。
- 表示順は unresolved → resolved。既定では resolved は件数のみ、
  解決済みの一覧を求められた場合は全件表示する。

```sh
find jobs -path '*/qa/*/index.md' -not -path '*/qa/status/*' -not -path 'jobs/.*' | sort
```

## 索引を検証する

各案件の `qa/status/unresolved/` / `qa/status/resolved/` を実体と照合し、次を「要確認」として報告する。
参照依頼では修復しない。

- `status` が未記入・未知の値。
- `id`が未記入・`Q-001`形式でない・同じ案件内で重複している。
- 索引に無い実体、両方の状態にあるリンク、実体の状態と索引の不一致。
- リンク切れ、リンク以外が索引に置かれている、`../../<同名>` 以外を指すリンク、実体の無い索引。

不正な status は未解決と決めつけず別に示す。壊れたリンクは `test -L` でも調べる。

## 報告例

```text
unresolved (2)
  PROJ-123 / guard-policy  ガードの水準をどこまで厳しくするか (internal)
  other / release-policy  共通のリリース方針をどうするか (customer)

resolved: 10 件
合計: unresolved 2 / resolved 10
```

依存があれば行末に `← <blockedBy>` を添える。
MEMORY・logs・QA のファイルは変更しない。
