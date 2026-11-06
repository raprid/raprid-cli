# 変更履歴

## v2.0.0 — 2026-11-06

v0.4.0から派生し、GitHub IssuesとWikiをローカルで編集・同期するワークスペースを追加。

- index.md本文、issue.json属性、remote.json取得情報、relations.json関係、fields.json組織属性を分離。
- Issue・コメント・親子・依存・Issue fieldsの取得と明示送信、差分プレビュー。
- 三者比較、送信結果確認待ち、部分成功記録、再照合、複数ファイル保存の復旧。
- Wiki専用Gitで取得・commit・push。分岐は通常マージし、強制上書きしない。
- Issues/WikiのTUI、編集時の版照合、送信プレビューの再照合。
- v0.4.0から別ディレクトリへ非破壊移行し、詳細・添付・元状態を保持。
- v2初期化は接続先指定が必須。旧形式はinit --legacy、既存コマンドも互換維持。

GitHub APIの排他保証、移行資料のリンク調整、非対応操作についてはREADMEの制約を参照。
