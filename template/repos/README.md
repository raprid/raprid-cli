# repos

関連リポジトリを、管理情報と submodule 本体を分けて保持する。

```text
repos/<リポジトリ名>/
├── repo/       # local/verification を使うローカル動作確認用 worktree
├── .worktrees/ # 作業・リモートブランチ用 worktree（Git 管理外）
├── MEMORY.md   # 現在のブランチ・HEAD・作業ツリー（reload-project が生成）
├── BRANCH.md   # Gherkin 形式のブランチ運用規約
└── WORKTREES.md # worktree の配置・統合手順
```

`repo/` は `origin/main` から分岐した `local/verification` 専用とする。
作業は `.worktrees/<ブランチ名>/` で行い、完了した作業ブランチを `repo/` にマージして
ローカル動作確認する。開発が落ち着いたら `repo/` を clean にし、必要に応じて `main` へ戻す。

作業前に `MEMORY.md` を読み、ブランチの作成・切替・統合を行う場合は
`BRANCH.md` と `WORKTREES.md` も読む。通常のソースへのパスは
`repos/<名前>/.worktrees/<ブランチ名>/src/...`、動作確認時は `repos/<名前>/repo/src/...` とする。

既存のローカルブランチと、origin に存在する `main` / `dev` / `stg` / `prod` は次で展開する。

```sh
./repos/setup_worktrees.sh <リポジトリ名>
```

全リモートブランチを一括展開しない。必要になったブランチだけ引数で追加する。

## アクセス権限

Claude Code / Codex 共通の運用上の範囲。sandbox や Git の権限を付与する設定ではない。
ユーザーが作業範囲を明示した場合はその依頼を優先し、実際の実行権限は別途確認する。

- `project_group`: 管理リポジトリからエージェントを起動したとき
- `submodule`: `repo/` 内でエージェントを起動したとき

| submodule_dir | project_group | submodule |
| --- | --- | --- |
| <例> | rwx | rwx |

## submodule の追加

```sh
./repos/add_submodule.sh <SSH URL> [--dir_name <名前>] <権限>
```

`repos/<名前>/{repo/,.worktrees/,MEMORY.md,BRANCH.md,WORKTREES.md}` を作り、上の権限表へ追記する。
権限は2桁で、1桁目が `project_group`、2桁目が `submodule`。
各桁は `4=r`、`2=w`、`1=x` の合計（例: `77` は双方 `rwx`）。
