# raprid v2

GitHub IssuesとWikiをローカルに蓄え、オフラインで閲覧・編集してから明示的に同期するCLI・TUI。v0.4.0（fa79e75）を起点とする。

Node.js 24以上、Git、macOSまたはLinuxが必要。GitHub認証は`GH_TOKEN` / `GITHUB_TOKEN`、または`gh auth login`を使う。トークンはワークスペースへ保存しない。WikiはGitのSSH認証（または取得済みHTTPS originの認証）を使用する。

## インストール

npmレジストリへは公開せず、GitHub Releaseのtarballを配布する。

```sh
npm install -g --allow-remote=all https://github.com/raprid/raprid-cli/releases/download/v2.2.0/raprid-2.2.0.tgz
raprid --version
```

最新版の固定名は`https://github.com/raprid/raprid-cli/releases/latest/download/raprid.tgz`。

## 開始する

```sh
raprid init my-work --repo owner/repository
cd my-work
raprid sync pull
raprid issue list --json
raprid tui
```

`init --dry-run`は既存ファイルとの衝突だけを検査する。`--no-git`でGit初期化を省略できる。GitHub Enterpriseは`--host github.example.com`で接続先を指定する（対象環境でAPIの提供状況を確認すること）。

## 保存形式

```text
workspace/
├── README.md / AGENTS.md / CLAUDE.md
├── issues/<local-id>/
│   ├── index.md                  # 本文（frontmatterなし）
│   ├── issue.json                # 編集する基本属性
│   ├── remote.json               # GitHubのID・番号・取得情報（自動更新）
│   ├── relations.json            # 親子・依存関係（取得成功時）
│   ├── fields.json               # 組織Issue fields（取得成功時）
│   └── comments/<local-id>/
│       ├── index.md
│       └── metadata.json
├── wiki/                         # Wiki専用Gitの作業ツリー
├── repos/                        # 関連コード
├── logs/                         # ローカルの作業記録
└── .raprid/
    ├── config.json
    ├── catalog/                  # リポジトリ・ラベル・種別などの定義
    ├── sync/
    │   ├── issues/<local-id>/     # base/・remote/・conflicts/・state.json
    │   ├── operations/            # 送信記録と結果確認待ち
    │   ├── writes/                # 中断したローカル保存の復旧
    │   └── wiki.json
    ├── cache/                    # 再生成可能
    └── locks/
```

Issueのフォルダ名は固定のローカルUUID。GitHubの番号は`remote.json`に保存する。親子関係でフォルダを入れ子にしない。`.raprid/sync/`はキャッシュではなく復旧に必要な永続情報なので、issues/と一緒にバックアップする。

`issue.json`の例:

```json
{
  "schemaVersion": 1,
  "title": "同期処理を実装する",
  "state": "open",
  "stateReason": null,
  "labels": ["enhancement"],
  "assignees": [],
  "milestone": null,
  "type": null
}
```

ラベルは名前、担当者はlogin、milestoneは番号、typeは名称。空配列は解除、nullは未設定を表す。未知の編集キーはエラー。取得できなかった関係やfieldsを空の解除指示として送信しない。

`relations.json`は`{schemaVersion:1,parent:null,children:[],blockedBy:[]}`。各参照は`{id,number,url}`。`id`はGitHubの数値IDで、Issue番号とは異なる。childrenは順序を持ち、blockedByは着手の依存関係。取得後に編集する。別リポジトリの参照も同じGitHubホストのURLを使う。

`fields.json`は`{schemaVersion:1,values:[{fieldId:123,value:"High"}]}`。選択型は選択肢の名前、複数選択は名前の配列。組織や権限により利用できない場合はstate.jsonに取得不能を記録し、値ファイルを作らない。

## ローカル編集

```sh
raprid issue create "タイトル" --body-file body.md
raprid issue show 42
raprid issue edit 42
raprid issue edit 42 --metadata
raprid issue comment 42 --body-file reply.md
raprid issue close 42 --reason completed
raprid issue reopen 42
```

番号のほかローカルUUIDでも指定できる。編集コマンドは`VISUAL` / `EDITOR`（実行ファイル名）を使用し、未設定時はvi。直接ファイルを編集してもよい。通常操作とCLI出力はJSON形式。

## 同期と復旧

```sh
raprid sync status
raprid sync pull
raprid sync push --dry-run
raprid sync push
```

pullは全状態のIssueをページング取得し、PRを除外する。本文・属性は同期基点、手元、リモートの三者で比較する。ラベル・担当者の独立した追加を統合し、本文や属性の競合を記録する。pushは更新直前に取得し、変更した項目だけを送り、返却値を照合する。関係とfieldsは専用APIで更新する。途中成功は記録し、競合や失敗は終了コード1で知らせる。

競合内容は`.raprid/sync/issues/<id>/conflicts/`で確認する。解決例:

```sh
raprid sync resolve 42 --take local
raprid sync resolve 42 --take remote --resource relations
raprid sync resolve 42 --take local --resource fields
raprid sync resolve 42 --take local --comment <comment-local-id>
```

`local`は手元の編集を採用し、最新取得を新しい基点とする。`remote`は手元を最新取得に合わせる。必要なら先に本文を編集してからlocalを選ぶ。関係・fieldsは途中成功や別操作の変更を確認して解決する。

送信後の通信断・異常終了は「結果確認待ち」にし、自動再送しない。

```sh
raprid sync reconcile <操作ID>
raprid sync reconcile <新規Issue作成の操作ID> --remote-id <GitHubのIssue番号>
raprid sync reconcile <コメント作成の操作ID> --remote-id <GitHubのコメントID>
```

既存IssueのPATCH照合先は変更できない。新規作成の結果が不明な間は、未対応のリモートIssueの取り込みも保留する。リモートで成立を確認できない操作は確認待ちのまま保持する。記録を消して再送すると二重作成の危険がある。

プロセス強制停止でロックが残った場合は、そのプロセスが終了したことを確認して`.raprid/locks/workspace/`だけを取り除く。中断したファイル保存は次のCLI操作で再開し、外部編集と競合した場合は上書きせず停止する。

## Wiki

GitHub上でWikiの最初のページを作成してから取得する。

```sh
raprid wiki pull
# wiki/のMarkdownを編集する
raprid wiki status
raprid wiki commit --message "同期設計を更新"
raprid wiki push --dry-run
raprid wiki push
```

Wikiは独立したGitリポジトリ。未コミット変更があるpull/pushは停止する。履歴の分岐はpullで通常のGitマージを行い、競合があればwiki/内で解決・コミットする。force pushはしない。WikiのGit操作はIssue同期とは独立している。

## TUI

`raprid tui`でIssuesとWikiを全画面表示する。Tab / Shift+Tabまたはh / lでペインを移動し、j / kまたは↑↓で選択・スクロールする。`w`でIssuesとWikiを切り替え、`?`で操作ヘルプを表示する。`r`はローカル再読込、`g`は取得、`p`はIssue送信のプレビュー。プレビューの`y`で再照合後に送信、`n`で取消。

`n`でIssue作成、`e`で本文、`t`でタイトルを編集する。編集は末尾入力方式でCtrl+Sが保存、Escが取消。自由なカーソル編集は`issue edit`を使う。`c`で終了/再開をローカル保存する。編集中に外部更新があれば保存せず入力を保持する。Wikiの編集・commit・pushと競合解決はCLIから行う。

## v0.4.0からの移行

```sh
raprid migrate ../old-work ../new-work --repo owner/repository
raprid migrate ../old-work ../new-work --repo owner/repository --apply
```

既定は計画表示。移行元と移行先は独立した場所にし、移行元は変更しない。tasks/QAを未送信Issueへ変換し、元frontmatter、詳細、添付、docsを`logs/migration/source/`に保持する。旧状態を受入済み・closedへ自動変換しない。

MarkdownのWiki候補は`.raprid/migration/wiki-pages/`へ生成する。`wiki pull`後、参照リンクとページ名を確認して必要なページをwiki/へ取り込む。非Markdown原本は保存した資料から参照する。移行では送信しない。

旧形式の生成は`raprid init --legacy <dir>`。既存のjob/task/qaコマンドと旧TUIを互換維持する。[旧形式の詳細](LEGACY.md)。新ワークスペースにはプロジェクトごとのscripts/を生成せず、raprid本体が操作する。

## 制約

- GitHubのPATCHは原子的な版照合を保証しない。更新直前の取得と結果照合を行うが、外部編集との完全な排他は保証しない。
- コメントの削除、Issueの削除・移管・duplicateへの変更はGitHub側で行う。ファイル削除をリモート削除へ変換しない。
- Projects固有のフィールド、リアクション、タイムライン全履歴の編集は対象外。取得APIの未知の属性はremote.jsonへ保持する。
- 工程・受入の独自ワークフローは自動実行しない。GitHubのcloseを人の受入完了として扱わない。
- TUIの日本語IME・実端末の表示、GitHubへの更新とWiki公開の実サービス往復は利用環境で確認すること。自動試験は模擬APIとローカルGitを使用する。

## 開発・配布

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
npm pack
```

旧雛形はv0.4.0の互換用として保持する。新形式の実装はsrc/workspace/、試験はtest/workspace*.test.ts。試験には競合・通信断・権限不足・中断復旧・実GitのWiki同期・非破壊移行・TUI編集競合を含む。

リリースはコミット・タグを固定して`raprid-2.2.0.tgz`と同一内容の`raprid.tgz`、SHA256SUMSをGitHub Releaseへ添付する。npm publishは行わない。

MIT License。
