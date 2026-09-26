# logs — agent のセッション記録

agent が行った作業を、日付・agent 名・セッション ID ごとに記録する。
**AI agent 専用の記録場所**であり、人間用の日報や `mine/` は置かない。

## ディレクトリ構成

```text
logs/
├── README.md
├── create_log.ts              # セッションログを作成する
├── create_log.test.ts         # 作成処理のテスト (pnpm test)
├── template/                  # 新規セッションの複製元 (直接編集しない)
│   ├── index.md
│   ├── _.md
│   └── outputs/
└── <YYYY>/<MM>/<DD>/<agent_name>/<session_id>/
    ├── index.md               # セッション全体の目的・作業・結果・次回
    ├── _.md                   # 個別の作業記録の複製元
    ├── <作業名>.md            # _.md を複製した個別の作業記録
    └── outputs/               # そのセッション中の成果物
```

配置例:

```text
logs/2026/09/26/claude/0b9d3c1e-5f0a-4c0e-9d4e-2f7c4b1a8e21/
logs/2026/09/26/claude/7a1f.../          # 同じ日・同じ agent の別セッション
logs/2026/09/26/codex/019a2b3c-.../
logs/2026/09/26/task-transition/5c2e.../ # 役割別 agent
```

## 命名規則

| 階層 | 規則 |
| --- | --- |
| `<YYYY>/<MM>/<DD>` | セッションを**開始した日**の実行環境のローカル日付。ゼロ埋め |
| `<agent_name>` | Claude Code 本体は `claude`、Codex 本体は `codex`、役割別 agent は `.claude/agents/` の定義名。英小文字・数字・ハイフン |
| `<session_id>` | agent が持つセッション ID があれば `--session` で渡し、無ければ省略して UUID を自動採番する。英数字・`_`・`-` |
| `<作業名>.md` | 作業内容が分かる英小文字とハイフン |

## 手順

### セッションを始める

```sh
pnpm log:create claude                                        # 当日・UUID を自動採番
pnpm log:create codex --session <session_id>                  # agent のセッション ID を使う
pnpm log:create codex --date 2026-09-24 --session <session_id> # 日付も指定する
```

作成されたパス (`logs/...`) を控え、同じセッションの間はそのディレクトリを使い続ける。
同時に実行しても、1つのセッションは1回だけ作られる。テンプレートは `logs/.tmp/` に複製してから移すので、
表示されたパスには常に完成した中身がある。`--session` 指定時は `logs/.locks/` で排他する (どちらも Git 管理外)。

### セッションを再開する

控えたパスをそのまま使うか、同じセッション ID で再実行して既存のパスを表示させる。

```sh
pnpm log:create claude --session <session_id>
# 既存のセッションログ: logs/2026/09/24/claude/<session_id>
```

* 再実行では既存のファイルを変更しない。
* `--date` を省略すると、全日付から同じ agent・セッション ID を探して再利用する。
  **日付をまたいでも、記録は開始日のディレクトリに書き続ける。**
* 開始日と異なる `--date` を指定した場合は、重複を作らずにエラーにする。

### 個別の作業記録を作る

セッション内の `_.md` を複製し、`index.md` の「作業」からリンクする。

```sh
cp logs/2026/09/26/claude/<session_id>/_.md logs/2026/09/26/claude/<session_id>/reload-project.md
```

書き込み権限を持たないサブエージェントの記録は、呼び出した側がそのエージェント名のセッションを作ってまとめる。

## docs/・job/ との使い分け

`logs/` は agent のセッション単位の時系列記録。継続的に参照する資料は `docs/`、
タスクの結論の根拠は `job/<案件名>/assets/` に置く。調査結果はまず `outputs/` に出し、
以後も参照するものだけ移す。

## 旧 daily/ からの移行

旧構成 `daily/<YYYY-MM>/<DD>/agents/<agent名>/` の AI 記録は
`logs/<YYYY>/<MM>/<DD>/<agent名>/daily-<YYYY-MM-DD>/` に移した。
旧記録にはセッション ID が無いため、移行元の日付を ID にしている。
旧 `mine/` (人間の記録) は新構成に含めない。
