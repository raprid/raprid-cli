# Codex 向けの入口

このリポジトリはプロジェクトの案件・記録・仕様・テストと関連 submodule を管理する。

## 最初に読むもの

1. [README.md](README.md) — 共通の構成・運用ルール。
2. [CLAUDE.md](CLAUDE.md) — 共通の作業手順。Claude 固有の部分は下記で補う。
3. [MEMORY.md](MEMORY.md) — 状況把握の索引。実ファイルと食い違う場合は実ファイルが正。

`@MEMORY.md` の自動展開には依存せず、ファイルを明示的に読む。
案件・領域で作業するときは、そこにある直下の `MEMORY.md` も読む（例: `jobs/<案件名>/MEMORY.md`）。
トップレベルは現在状況、トピック側は詳細という分担。
読み込み・一覧・相談だけの依頼ではファイルを更新しない。MEMORY が古ければその旨を伝え、
更新を依頼されたとき、または変更作業の区切りに `reload-project` を使う。

## Codex での作業

- スキルは `.agents/skills/` から見つかる。ここは `../.claude/skills` への相対リンクで、
  指示・スクリプト・雛形の実体は `.claude/skills/` に一つだけ置く。
- Codex は `$list-task`、Claude Code は `/list-task` のように呼ぶ。自然文での依頼にも対応する。
  スキルを使う前に、その `SKILL.md` と参照先の [共通実行ルール](.claude/skills/runtime.md) を読む。
- `AskUserQuestion`、Claude in Chrome、`.claude/agents/` は Codex に自動登録されない。
  利用できる質問・ブラウザ・画像閲覧ツールに読み替える。存在しないツールを呼ばない。
- タスク状態の変更には共有の `task-transition` スキルを使う。サブエージェントは必須ではない。
- Codex の作業記録は `logs/<year>/<month>/<day>/codex/<session_id>/` に書く。
  他のエージェントの記録には書かない。作成方法は `logs/README.md` に従う。
- submodule の権限は `repos/README.md` に従う。親リポジトリからの作業で、スキル利用だけを
  根拠に submodule の編集・起動・DB 更新の範囲を広げない。ユーザーが明示した範囲を優先する。
- submodule のローカル動作確認は `repos/<名前>/repo/`、作業ブランチは
  `repos/<名前>/.worktrees/<ブランチ名>/`。作業前に同階層の `MEMORY.md` を読み、
  ブランチの作成・統合・切替を伴う場合は `BRANCH.md` と `WORKTREES.md` も読む。
- 既存の未コミット変更を保持する。コミット・push・外部への送信は依頼された場合に限る。
- `MEMORY.md` は reload-project が生成する。トップレベルは 800 トークン以内、各トピック直下は 500 トークン以内。手で状況を追記せず、実ファイルから更新する。
- ドキュメント・コメント・コミットメッセージは日本語にする。

## このプロジェクトで特に守ること

- タスクと QA の状態は実体 (`jobs/<案件名>/tasks/<タスク名>/index.md`、`qa/<QA名>/index.md`) の
  frontmatter `status` が正。状態ディレクトリのリンクは索引。
  状態変更では実体の状態・日付・依存関係とリンクを一緒に更新する。
  QA は案件内の `jobs/<案件名>/qa/`、案件外のものは `jobs/other/qa/` に置く。
- タスクは案件内の`T-001`形式、QAは`Q-001`形式の固定IDを持つ。追加・一覧・状態変更・詳細の追加の
  機械操作には `raprid <group> <command>` (CLI が無ければ `pnpm raprid` か `node scripts/cli.ts`) を使える。
- テストの仕様は `docs/feature/**/*.feature` が正。案件固有の Playwright spec を置く場合は
  `jobs/<案件名>/assets/e2e/` で写しとして管理する。
  未実施や確認不能を OK にせず、過去の結果と今回の実行結果を区別する。
- ブラウザや Excel が利用できなくても、可能な準備・生成・機械検証を先に終え、
  実機で未確認の部分を明記する。閲覧できていない画像を確認済みにしない。
