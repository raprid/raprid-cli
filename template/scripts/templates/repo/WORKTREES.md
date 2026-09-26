# {{name}} worktree 運用

`repo/` は `origin/main` から分岐した `local/verification` 専用とする。
作業ブランチと、使用するリモートブランチは `.worktrees/<ブランチ名>/` に置く。

## 手順

1. `raprid repo setup-worktrees {{name}}` で既存ブランチを展開する。
2. 新規作業は最新の `origin/main` から `.worktrees/<ブランチ名>/` に作る。
3. 作業ブランチを `repo/` の `local/verification` にマージしてローカル動作確認する。
4. 検証が落ち着いたら `repo/` を clean にし、必要に応じて `main` へ戻す。

`.worktrees/` はローカル専用で Git 管理しない。一つのブランチを複数の worktree で開かない。
ブランチ固有の統合規約は [BRANCH.md](BRANCH.md) を参照する。
