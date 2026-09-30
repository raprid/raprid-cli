---
name: task-transition
description: jobs/ 配下の既存タスクの工程を進める (引受・完了・判定・待ち・再開・やり直し・担当の変更)。工程型タスク (workflowVersion 3) は raprid task claim などの工程の操作で、移行前の旧形式は frontmatter の status と状態索引を一緒に更新する。新規登録は add-task、一覧表示は list-task を使う。
---

# task-transition

先に [共通実行ルール](../runtime.md) と README.md の「工程型タスク」「タスクの管理方式」を読む。
Claude Code と Codex のどちらでも本体が実行でき、サブエージェントは必須ではない。

まず対象の形式を確かめる: `raprid task show <案件名> <ID> --json --schema-version 2` の `item.workflowVersion` が
3 なら工程型 (下の「工程型タスク」)、無ければ旧形式 (後半の「旧形式のタスク (移行前)」)。
2 (工程が implement) は操作できないので、`raprid job migrate-workflow` での移行を案内する。

## 工程型タスク (workflowVersion 3)

工程は `plan` → `execute` → `review` → `acceptance`。今の工程 (`phase`) と工程の状態 (`phaseStatus`) を見て、
次の操作を選ぶ。**単純な状態の指定 (`task move`) はできない。工程を飛ばしたり、承認を迂回したりしない。**

| 今の状態 | 操作 | コマンド (すべて `--if-match <revision>` が必須) |
| --- | --- | --- |
| ready | 引き受ける | `raprid task claim <案件> <ID> --actor <担当>` (担当が未定か自分のとき) |
| progress (plan・execute) | 完了する | `raprid task complete <案件> <ID> --actor <担当> --handoff <引継資料.md> [--artifact <パス>] [--commit <repo>:<commit>]` |
| progress (review・acceptance) | 判定する | `raprid task decide <案件> <ID> approved\|changes_requested --actor <担当> --report <記録.md> [--return-to plan\|execute --reason <理由>]` |
| progress | 待ちにする | `raprid task block <案件> <ID> --actor <actor> --blocked-by <相手> [--reason <理由>]` |
| pending | 再開する | `raprid task resume <案件> <ID> --actor <actor>` |
| pending 以外 (closed は人だけ) | やり直す | `raprid task reopen <案件> <ID> --return-to plan\|execute --actor <actor> --reason <理由>` |
| done・pending 以外 (作業中の交代は `--handoff` が必要) | 担当を替える | `raprid task assign <案件> <ID> <工程> <担当> --by <actor> --reason <理由> [--handoff <md>]` |

* revision は操作の直前に `raprid task show <案件> <ID> --json --schema-version 2` の `item.revision` を読む。
  `REVISION_CONFLICT` なら読み直して、状態が変わっていないか確かめてから判断し直す (自動で送り直さない)
* **完了・判定の前に完了条件と依頼内容を照合し、未実施を完了にしない。** 引継資料 (`--handoff`) には
  「対象・成果物」「実施・検証」「未確認・制約」「次の担当への依頼」の節を書く (`raprid task note` で詳細 md を作る)。
  実装 (`implementation`) の実行の完了には、対象の `--commit` か `--artifact` を付ける
* **職務分離**: 実行 (`execute`) を完了した actor は同じ成果物をレビューしない。自分が実装したものを自分で承認しない。
  **受入確認 (`acceptance`) の担当と判定は人 (`human/…`) だけ。AI は受入確認を代行しない** (人に依頼して待つ)
* 待ちの相手 (`--blocked-by`) は同じ案件の `qa/Q-001`、`task/T-001`、別案件の `qa/<案件名>/Q-001`、
  または `other: <待ちの内容>`。人への質問で待つなら `raprid task ask <案件> <ID> <QA名> <確認先> <質問> --actor … --if-match …`
  で QA の起票と待ちを一体で行う
* 規則に合わない操作は scripts/ が `WF_…` の code で拒否する (何も変えない)。拒否の理由を読み、規則を回避しない
* やり直せるのは人か今の工程の担当、受入確認の担当を決められるのは人だけ
* 作業索引 (`status/<工程>/<工程の状態>/<名前>`) はコマンドが一緒に動かす。手で `mv` しない

操作の後に `raprid task show … --json --schema-version 2` で `phase`・`phaseStatus`・`assignee` を確かめ、
対象、変更前 → 変更後、理由、引継資料・記録のパスを報告する。

## 旧形式のタスク (移行前)

移行前の旧形式 (`status: todo/progress/pending/done`) のタスクだけに使う。移行した後のプロジェクトでは使わない。

### 1. 対象と根拠を確認する

- 実体は `jobs/<案件名>/tasks/<タスク名>/index.md`。指定には案件内で固定の`T-001`形式のIDを優先し、
  タスクのディレクトリ名の完全一致も受け付ける。
  案件とタスクが会話から一意なら質問せず進める。
- 現在の状態は実体の frontmatter `status` を読む。リンク位置だけで決めない。
- todo は着手可能、progress は着手中、pending は外部待ち、done は完了。
  done にする前に完了条件・結果と依頼内容を照合し、未実施を完了にしない。
- pending の `blockedBy` は同じ案件の `qa/Q-001`、`task/T-001`、
  別案件を指す `qa/<案件名>/Q-001`、または
  `other: <待ちの内容>` を記入する。会話に理由があればそのまま使う。
- 通常は todo → progress → done、todo/progress → pending、pending → todo/progress。
  差し戻し・再開・完了の直接指定も、理由が明確なら指定に従う。
- 人への質問で待ちになる場合は、QAを別操作で作ってから移すのではなく
  `raprid task ask <案件> <タスク> <QA名> <確認先> <質問> --requested-by <actor> --created-by <actor>` を使う。
  QAの作成と `pending` 化が一体で失敗または成功する。

### 2. 書き換える前に索引を確認する

`status/{todo,pending,progress,done}/` の同名リンクを調べ、
相対リンク `../../tasks/<同名>` が一つだけあること、
リンク先を読めること、移動先が空いていることを確認する。
移動先の壊れたリンクも衝突になるので `test -e` と `test -L` の両方を見る。

通常ファイルが索引にある、別の実体を指す、複数リンクがあるなど、対象が曖昧になる
不整合は上書きせず報告する。実体と索引の状態が違うだけなら、実体を基準に、
依頼された最終状態へ両方を揃える。索引が無い場合は正しい相対リンクを作る。

### 3. 実体とリンクを更新する

機械的な更新には次を使う (CLI が無ければ `pnpm raprid task move` か `node scripts/cli.ts task move`)。

```sh
raprid task move <案件名> <タスクIDまたは名前> <変更後状態> [blockedBy]
```

このコマンドはIDと状態索引を検証し、frontmatterと相対リンクを一体で更新する。
未知の項目・コメント・本文は変更せず、途中で失敗した場合は自分の変更だけを戻す。
ただし、`done`にしてよいか、`pending`の理由が妥当かという判断は実行前にこのスキル側で行う。
判断根拠は `raprid task note` で作る詳細 md か、`index.md` の「結果」に書く。

コマンドが使えない場合は、実体を移動せず、使用環境の編集ツールで次を更新する。

- `status`: 遷移先。
- `updatedAt`: 作業日 (YYYY-MM-DD)。
- `completedAt`: done なら完了日。done から再開した場合は空にする。
- `blockedBy`: pending なら待ちの相手。待ちが解消した場合は空にする。
- `createdAt` / `test` / 過去の詳細 md は保持する。判断根拠を詳細 md か「結果」に追記する。

対応するリンクを `status/` 内で `mv` するか、索引が無ければ
`ln -s ../../tasks/<名前> jobs/<案件名>/status/<状態>/<名前>` で作る。
実体とリンクの間で失敗した場合は、変更前の内容を使って自分の変更だけを戻し、
不一致を残したまま完了と報告しない。既存のユーザー変更は保持する。

### 4. 検証と報告

- frontmatter と索引が一致する。
- リンクは一つだけで、正しい相対パスを指し、実体を読める。
- pending に理由がある。done の完了日、再開時の空欄が正しい。
- QA回答後は `qa resolve --answered-by <actor>` の再開待ち表示を確認し、回答を作業へ反映するときに todo または progress へ明示的に戻す。
- 変更対象以外を変更していない。

対象、変更前 → 変更後、理由、変更したパス、検証結果を報告する。
自分のセッションログに記録し、変更作業の区切りに reload-project で MEMORY を更新する。
