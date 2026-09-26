# feature — Gherkin 手順書

Gherkin 記法で書いた手動テストの手順。**現在の仕様に合致しているものだけを置き、
古くなったら `archived/` に逃がす。**

以下の `/verify-task` / `/run-manual-test` は Claude Code の呼び方。
Codex では `$verify-task` / `$run-manual-test` を使う。操作・録画できない範囲は未実施と報告する。

```
docs/feature/
├── <領域>/<機能>/     # admin/item-edit/ のように機能ごとに切る
└── archived/          # 仕様が変わって使えなくなったもの (同じ相対パスで置く)
```

手順はタスクより長生きする。タスクが `done` になっても仕様は残り、
次の案件で同じ画面をテストするときにそのまま使える。
だから `jobs/` の中ではなくここに置く。

## ディレクトリとファイルの切り方

**`docs/feature/<領域>/<機能>/<章番号>-<内容>.feature`。1 ファイル = 1 `Feature:` = 1 章。**

```
docs/feature/admin/item-edit/
├── _background.feature                 # 前提と共通操作 (実行対象ではない)
├── 00-setup.feature                    # Feature: 0. 準備
├── 01-validation.feature               # Feature: 1. 入力検証
└── 02-save.feature                     # Feature: 2. 保存
```

* **1 ファイルの中身は最小限にして、章ごとに分ける。** 章単位で「ここだけ再実行する」
  ができ、仕様変更で古くなった章だけを `archived/` に逃がせる
* ファイル名は `<章番号 2 桁>-<内容>.feature`。章番号を持たせると
  `ls` の順序が実行順になり、`@P-3-2` の `3` からファイルが引ける
* **`_` で始まるファイルは実行対象にしない。** 同じディレクトリの全 feature に効く
  `Background:` と共通操作を置く (`scripts/templates/task/_.md` と同じ `_` の使い方)
* その章だけの前提は、そのファイルに `Background:` を書いてよい

## 記法

* `Feature: <番号>. <章題>` — ファイル名の章番号と一致させる
* シナリオには **`@<接頭辞>-<章>-<連番>` タグ**を付ける。接頭辞は領域ごとに決める
* **各ステップに `(1)` から始まる通し番号**を付ける。
  「P-3-2 の (5) で NG」と指せるようにするため
* 共通操作のステップは `(a)`〜`(f)` のアルファベットで番号を分け、
  各シナリオから「共通操作 (c)〜(f) で連携先を選ぶ」と参照する
* `#` コメントに実装上の根拠を `ファイル:行` で添える
* SQL / curl / JS は `When` `Then` の続き行にインデントして直書きする

```gherkin
Feature: 1. 入力検証

  @ADM-1-1
  Scenario: 必須項目が空なら保存できない
    Given (1) 編集対象のデータを用意する
    When  (2) http://localhost:3000/admin/items/<ID> を開く
    And   (3) 必須項目を空にして保存する
    Then  (4) 必須項目のエラーが表示される
```

### skill 向けのタグ

| タグ | 意味 |
| --- | --- |
| `@manual` | ブラウザから自動化できない。`/run-manual-test` は飛ばし、`/verify-task` に回す |
| `@destructive` | **テスト対象そのもの以外の状態を変える。** 実行前に確認を取る |

`@manual` を付けるのは、論理削除など**押すと戻すのが面倒なボタン**、
外部IDプロバイダー 経由のログイン、OS のダイアログを伴う操作。

`@destructive` は「DB を書き換えるか」ではない。**対象の行のステータスを
`Given` で作るのは普通のことなので付けない。** 付けるのは、ログインユーザーの権限、
他の行、論理削除のように**そのシナリオの対象外に影響が及ぶ**とき。
どちらにせよ、その回で流した `UPDATE` は最後に全部戻す
(タグの有無と後片付けは別の話)。

## 背景情報は docs/unofficial/ 側に置く

feature には**手順だけ**を書く。画面構成図・ステータス値の対応表・データ準備の SQL・
確認できないことは `docs/unofficial/<案件名>/` に置き、
`_background.feature` の先頭コメントからリンクする。

手順と背景を分けるのは、手順が機械に読まれる一方で、背景は人が読むもののため。

## タスクとの紐付け

タスク md の frontmatter `test:` に、この下のパスを書く。

```yaml
test:
  - docs/feature/admin/item-edit/               # ディレクトリなら _ 以外を名前順に全部
  - docs/feature/account/profile/03-avatar.feature
```

**`@ID` とタスクの `## 完了条件` のチェックは 1:1 で対応させる。** 検証はスクリプトで行う。

```sh
./.claude/skills/verify-task/check_scenario_ids.sh jobs/<案件名>/tasks/<タスク名>/index.md
```

実行は `/verify-task` (対話で人が確認) か `/run-manual-test` (Chrome で実行して GIF を撮る)。
結果と GIF は `jobs/<案件名>/tasks/<タスク名>/assets/<実行日>/` に残る
([README.md](../../README.md) の `jobs/` の節)。

## 案件固有の自動実行コード

Playwright などの実行コードが必要なら `jobs/<案件名>/assets/e2e/` に置く。
**`.feature` が仕様の正で、spec は機械実行用の写し**とし、仕様変更は feature から反映する。
spec の test title にはシナリオ ID を入れ、手順との対応を追跡できるようにする。
実行方法、認証状態の作り方、対象環境、対応確認コマンドは同ディレクトリの README に記載する。
`@manual` と `@destructive` は既定の自動実行から除外する。

## 古くなったら archived/ へ

仕様が変わって使えなくなった feature は**消さずに** `archived/` へ `git mv` する。
「当時はこうだった」を後から引けるようにするため。

```sh
mkdir -p docs/feature/archived/admin/item-edit
git mv docs/feature/admin/item-edit/01-validation.feature \
       docs/feature/archived/admin/item-edit/
```

**移した feature の先頭コメントに、いつ・なぜ古くなったかを書く。**

```gherkin
# 2026-01-15 に入力仕様が変更されたため archived。
# 変更前の必須項目に対する手順として残す。
```

`archived/` の中は元と同じ相対パスにする (`docs/feature/admin/...` → `docs/feature/archived/admin/...`)。

## 運用

* 空ディレクトリには `.gitkeep` を置く ([README.md](../../README.md) の規約)。
* ファイル名は英小文字とハイフン。
