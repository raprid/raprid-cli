---
name: reload-project
description: プロジェクトの現状をトップレベル MEMORY.md に、案件・領域の詳細を各ディレクトリ直下の MEMORY.md に再生成する。状態の更新を依頼されたとき、または変更作業の区切りに使う。読み込みや一覧だけの依頼では更新しない。
---

# reload-project

先に [共通実行ルール](../runtime.md) を読む。読取専用の依頼なら再生成せず、差異だけを報告する。

リポジトリ全体をスキャンして、トップレベルとトピックごとの `MEMORY.md` を作り直す。差分更新ではなく**毎回全体を再生成する**。

トップレベルのサイズ上限: **800 トークン** / 警告: **600 トークン**。
トピックディレクトリ直下のサイズ上限: **500 トークン** / 警告: **400 トークン**。

## 手順

### 1. スキャンする

以下をすべて実行し、結果を集める。ファイルが無い・ディレクトリが空の場合はその項目を「なし」として扱う。

```sh
# リポジトリの状態
git status --short
git log --oneline -10

# セッションログ: 記録のある直近3日付の全セッション (logs/<YYYY>/<MM>/<DD>/<agent_name>/<session_id>)
find logs -mindepth 3 -maxdepth 3 -type d -path 'logs/[0-9]*' | sort | tail -3 \
  | while read -r d; do find "$d" -mindepth 2 -maxdepth 2 -type d; done | sort

# 案件の一覧
find job -mindepth 1 -maxdepth 1 -type d -not -name template | sort

# タスク・QA の実体 (状態は各 frontmatter から読む)
rg --files job -g '*.md' -g '!template.md' | rg '^job/[^/]+/list/[^/]+\.md$'
rg --files job -g '*.md' -g '!template.md' | rg '^job/[^/]+/qa/list/[^/]+\.md$'

# ドキュメント: 分類ごとの案件ディレクトリ、Gherkin feature / ファイル
find docs -mindepth 2 -not -name '.gitkeep' -not -name 'README.md' | sort

# submodule
cat .gitmodules 2>/dev/null
git submodule status
sed -n '/submodule_dir/,/^$/p' repos/README.md
find repos -mindepth 2 -maxdepth 2 -type d -name repo | sort
find repos -mindepth 2 -maxdepth 2 -type d -name .worktrees | sort
```

次に中身を読む。

* **セッションログ**: 直近3日付の各セッションの `index.md` を読む。未記入のログは実作業として要約しない。
  同じ日・同じ agent の複数セッションは1行にまとめてよいが、セッション数と代表パスを添える。
  記録した agent と実パスを添え、後から追記された結果まで確認する。必要なら個別ログを読む。
* **ドキュメント**: official / unofficial / personal は分類・案件ごとに数え、
  `docs/feature/` は現行・archived別に `.feature` を数える。xlsx 等の更新内容は案件の README を索引として読む。
  ディレクトリ数とファイル数を混同せず、数える対象を明記する。全画像を読む必要はない。
* **タスク**: `list/` の実体の frontmatter `id`と`status`を読み、案件内の固定IDを添えて分類する。progress は
  「内容」「完了条件」「結果」を読む。todo は名前、done は件数でよい。
  pending は `blockedBy` を添える。索引の無い実体も含め、索引との不一致は報告する。
* **QA**: 各 `job/<案件名>/qa/list/` の実体のfrontmatter `id`と`status`を読み、`status: unresolved`を未解決として扱う。
  「質問内容」を要約し、確認先・依存関係を添える。回答欄の空白やリンク位置で判定しない。
  frontmatter の `job` と親ディレクトリが一致するかも確認する。案件外は `job/other/qa/` に置く。
* **submodule**: `repos/<名前>/repo/` の現在ブランチ・HEAD・作業ツリー、
  `git worktree list` で `.worktrees/` のブランチと状態、同階層の `BRANCH.md`・`WORKTREES.md`、
  `repos/README.md` の権限を確認する。
  リモートの MR 状態を取得していない場合は「ローカル記録上」と区別する。

配列は `blockedBy: [qa/xxx]` と複数行形式の両方を読む。
タスクIDは案件内の`T-001`形式、QA IDは`Q-001`形式を正とし、欠落・形式不正・重複は報告する。
`template.md` はタスク・QA の件数に含めない。索引の点検は list-task / list-qa と同じ基準。

タスクと QA はどちらも**実体が `list/` にある**。タスクの状態索引は
`status/` 配下から `../../list/<名前>.md`、QA の状態索引も `qa/status/` から `../../list/<名前>.md` を指す
相対シンボリックリンクである (詳細は README.md)。

| 対象 | 実体 | 状態ディレクトリ |
| --- | --- | --- |
| タスク | `job/<案件名>/list/` | `status/{todo,pending,progress,done}/` |
| QA | `job/<案件名>/qa/list/` | `qa/status/{unresolved,resolved}/` |

### 2. MEMORY.md を生成する

下の「トップレベル出力フォーマット」に従ってトップレベル `MEMORY.md` を丸ごと書き直す。
トップレベルには現在の状況とトピック MEMORY へのリンクだけを置き、詳細を重複させない。
セクションの見出しと順序は固定する (差分が読みやすくなるため)。
該当する情報が無いセクションには `なし` と書き、セクション自体は消さない。

書き方のルール:

* 事実だけを書く。推測や評価は書かない。
* 各項目に**実ファイルへのパスを添える**。MEMORY.md は詳細の代わりではなくインデックスである。
* 日付は `YYYY-MM-DD` の絶対表記で書く (「昨日」「先週」と書かない)。
* 完了済み (`status: done`) のタスクは件数のみ。名前を並べない。
* 不整合を理由にタスクや QA を勝手に修復しない。MEMORY の更新だけを行う。
* 今回のコード変更・テスト実行と、過去の記録から読んだ結果を区別する。

### 3. トピック MEMORY を生成する

対象ディレクトリごとに `MEMORY.md` を作成または全置換する。内容はそのディレクトリの目的、主要な状態、参照先に絞り、**500 トークン以内**にする。
対象は存在する `job/*`、`docs/{official,unofficial,personal}/*`、`docs/feature/`、`repos/`、
`repos/*/`。`template/`、`repos/*/repo/` 内部、`logs/` は対象外とする。
案件はタスクの status 件数・progress / pending・関連 QA、docs は資料とGherkin正本の索引、
`repos/MEMORY.md` は全submoduleの索引、`repos/<名前>/MEMORY.md` は
`repo/` の動作確認ブランチと `.worktrees/` の個別の現在状態、
案件固有の実行コードは該当する `job/<案件名>/MEMORY.md` に記載する。
未解決 QA は対応する `job/<案件名>/MEMORY.md` に記載する。
トップレベルの全体状況を重複して書かず、トップレベル MEMORY から各トピック MEMORY へリンクする。

### 4. サイズを検証する

```sh
./.claude/skills/reload-project/count_tokens.sh MEMORY.md
```

* トップレベルは 600 以下、トピックは 400 以下なら余裕ありとして確定する。
* 警告を超えて上限以下なら確定してよいが、報告に概算を添える。
* 上限を超えたら下の圧縮ルールを適用し、収まるまで繰り返す。

### 5. 報告する

更新後、以下をユーザーに伝える。

* 概算トークン数 (上限に対する割合)
* 前回から変わった点 (新しい job / 完了したタスク / 新しい未解決 QA など)
* 圧縮した場合はどの情報を落としたか

## 圧縮ルール

上限を超えた場合、以下の順で削る。

1. トップレベルは詳細をトピック MEMORY へのリンクに置き換える
2. セッションログを直近1日付に減らす
3. todo / pending / QA は件数とパスだけにする
4. トピックは完了済みを件数だけにし、古い経緯・重複説明を落とす
5. それでも超える場合は更新日の新しい順に上位だけ残し、残りを件数でまとめる

`## プロジェクト概要` と各セクションの見出しは削らない。

## トップレベル出力フォーマット

```markdown
# MEMORY

> `reload-project` スキルで自動生成される。手で編集しない。
> 最終更新: YYYY-MM-DD / 概算 NNN トークン (上限 800)

## 現在の状況

プロジェクトの目的と現在のフェーズを2〜3行で。詳細はトピック MEMORY を参照。

## 進行中の job

### <案件名> (`job/<案件名>/`)

- progress / todo / pending: 件数と `job/<案件名>/MEMORY.md`
- done: N 件

## 直近の活動

- YYYY-MM-DD (`logs/<year>/<month>/<day>/<agent_name>/<session_id>/index.md`) — 結果と残作業を1行
- 未解決 QA N 件（各 `job/<案件名>/MEMORY.md`）

## docs

- official / unofficial / personal: 件数 (`docs/MEMORY.md`)

## submodule

- submodule: N 件 (`repos/MEMORY.md`)

## トピック MEMORY

- `job/*/MEMORY.md`
- `docs/*/MEMORY.md`
- `repos/MEMORY.md`
```
