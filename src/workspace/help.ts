export const help = `raprid v2 — GitHub Issues / Wiki をローカルで管理
  init <dir> --repo owner/repo [--host github.com] [--dry-run] [--no-git]
  issue list [--json]
  issue show <id|#番号>
  issue create <タイトル> [--body-file path]
  issue edit <id|#番号> [--metadata]
  issue close|reopen <id|#番号> [--reason completed|not_planned]
  issue comment <id|#番号> --body-file path
  sync pull|status|push [--dry-run]
  sync resolve <id|#番号> --take local|remote
  sync reconcile <操作ID> [--remote-id 番号]
  wiki status|pull|commit|push [--dry-run] [--message 内容]
  migrate <旧ワークスペース> <新ワークスペース> --repo owner/repo [--apply]
  tui
本文はindex.md、属性はissue.json。編集はローカル保存、送信はsync pushで明示実行。
Wiki送信はwiki commit→wiki push。GitHub認証はGH_TOKENまたはgh auth loginを利用。`;
