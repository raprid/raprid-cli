#!/usr/bin/env bash
#
# repos配下への管理ディレクトリ・submodule・worktree構成の追加と、README.mdの権限表更新を行う。
#
# 使い方:
#   ./add_submodule.sh <リモートリポジトリのssh経由URL> [--dir_name <ディレクトリ名>] <権限>
#
#   <権限> は2桁の数字。1桁目がproject_group、2桁目がsubmoduleのrole。
#   4=r / 2=w / 1=x の合計値で指定する (7=rwx)。
#
# 例:
#   ./add_submodule.sh git@github.com:example/foo.git --dir_name foo 77

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
README="${SCRIPT_DIR}/README.md"
SETUP_WORKTREES="${SCRIPT_DIR}/setup_worktrees.sh"

usage() {
  cat <<'EOS'
使い方:
  ./add_submodule.sh <リモートリポジトリのssh経由URL> [--dir_name <ディレクトリ名>] <権限>

引数:
  <リモートリポジトリのssh経由URL>  例: git@github.com:example/foo.git
  <権限>                            2桁の数字。1桁目=project_group、2桁目=submodule
                                    4=r / 2=w / 1=x の合計値 (7=rwx)

オプション:
  --dir_name <ディレクトリ名>  submoduleを配置するディレクトリ名
                               (省略時はURLのリポジトリ名を使用)
  -h, --help                   このヘルプを表示

実行内容:
  1. repos/<ディレクトリ名>/repo へのsubmodule追加
  2. repo/ を local/verification に切り替え、.worktrees/ に利用ブランチを展開
  3. 同階層への MEMORY.md / BRANCH.md / WORKTREES.md 作成
  4. repos/README.md のアクセス権限テーブルへの行追加
EOS
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# 権限の1桁 (0-7) を rwx 表記に変換する
perm_to_rwx() {
  local d="$1" s=""
  if (( (d & 4) != 0 )); then s="r"; else s="-"; fi
  if (( (d & 2) != 0 )); then s="${s}w"; else s="${s}-"; fi
  if (( (d & 1) != 0 )); then s="${s}x"; else s="${s}-"; fi
  printf '%s' "$s"
}

# --- 引数解析 --------------------------------------------------------------

url=""
dir_name=""
perm=""
positional_count=0

while (( $# > 0 )); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --dir_name)
      (( $# >= 2 )) || die "--dir_name にはディレクトリ名の指定が必要です"
      dir_name="$2"
      shift 2
      ;;
    --dir_name=*)
      dir_name="${1#*=}"
      shift
      ;;
    -*)
      die "不明なオプション: $1"
      ;;
    *)
      case "$positional_count" in
        0) url="$1" ;;
        1) perm="$1" ;;
        *) die "引数が多すぎます: $1" ;;
      esac
      positional_count=$(( positional_count + 1 ))
      shift
      ;;
  esac
done

if [[ -z "$url" || -z "$perm" ]]; then
  usage >&2
  die "URLと権限は必須です"
fi

[[ "$perm" =~ ^[0-7][0-7]$ ]] || die "権限は2桁の数字 (各桁0-7) で指定してください: $perm"

# ディレクトリ名の省略時はURLのリポジトリ名を使用する
if [[ -z "$dir_name" ]]; then
  dir_name="${url##*/}"   # git@host:org/repo.git -> repo.git
  dir_name="${dir_name##*:}"  # git@host:repo.git   -> repo.git
  dir_name="${dir_name%.git}"
fi

[[ -n "$dir_name" ]] || die "ディレクトリ名を判別できませんでした。--dir_name で指定してください"
[[ "$dir_name" != */* ]] || die "ディレクトリ名にディレクトリ区切りは使用できません: $dir_name"

project_group_perm="$(perm_to_rwx "${perm:0:1}")"
submodule_perm="$(perm_to_rwx "${perm:1:1}")"

# --- 事前チェック ----------------------------------------------------------

repo_root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" \
  || die "gitリポジトリ内で実行してください"

if [[ "$SCRIPT_DIR" == "$repo_root" ]]; then
  wrapper_path="$dir_name"
else
  wrapper_path="${SCRIPT_DIR#"$repo_root"/}/$dir_name"
fi
submodule_path="${wrapper_path}/repo"

[[ -f "$README" ]] || die "README.mdが見つかりません: $README"
[[ -x "$SETUP_WORKTREES" ]] || die "setup_worktrees.shが見つからないか実行できません: $SETUP_WORKTREES"

grep -qE '^[[:space:]]*\|[[:space:]]*submodule_dir[[:space:]]*\|' "$README" \
  || die "README.mdにアクセス権限テーブルのヘッダが見つかりません"

[[ ! -e "${SCRIPT_DIR}/${dir_name}" ]] \
  || die "すでに存在します: ${submodule_path}"

# --- submodule追加 ---------------------------------------------------------

printf 'submoduleを追加します: %s -> %s\n' "$url" "$submodule_path"
mkdir "${SCRIPT_DIR}/${dir_name}"
git -C "$repo_root" submodule add "$url" "$submodule_path"

# --- 管理ファイル作成 -------------------------------------------------------

default_branch="$(git -C "${SCRIPT_DIR}/${dir_name}/repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
default_branch="${default_branch#origin/}"
[[ -n "$default_branch" ]] || default_branch="未確認"

"$SETUP_WORKTREES" "$dir_name"

current_branch="$(git -C "${SCRIPT_DIR}/${dir_name}/repo" branch --show-current)"
head="$(git -C "${SCRIPT_DIR}/${dir_name}/repo" rev-parse --short=8 HEAD)"

cat > "${SCRIPT_DIR}/${dir_name}/MEMORY.md" <<EOF
# ${dir_name}

関連リポジトリの submodule。動作確認用は \`repo/\`、作業用は \`.worktrees/\`。
規約は [BRANCH.md](BRANCH.md) と [WORKTREES.md](WORKTREES.md)。

- 既定ブランチ: \`${default_branch}\`
- 現在: \`${current_branch}\` / \`${head}\`
- 作業ツリー: clean
EOF

cat > "${SCRIPT_DIR}/${dir_name}/BRANCH.md" <<EOF
# ${dir_name} ブランチ運用

\`\`\`gherkin
# language: ja
機能: ${dir_name} の変更を対象ブランチへ安全に統合する

  背景:
    前提 リモートの既定ブランチは "${default_branch}" である
    かつ "repo/" は "origin/main" から分岐した "local/verification" 専用である
    かつ 作業ブランチは ".worktrees/<ブランチ名>/" に置く

  シナリオ: 作業を開始する
    前提 最新の "origin/main" を取得している
    もし 作業ブランチを作成する
    ならば 最新の "origin/main" から分岐する
    かつ ブランチ名に課題番号または変更目的を含める
    かつ ".worktrees/<ブランチ名>/" に作成する

  シナリオ: ローカル動作確認を行う
    前提 作業ブランチの変更が確定している
    もし "repo/" の "local/verification" に作業ブランチをマージする
    ならば 複数リポジトリを組み合わせて動作確認する

  シナリオ: 開発が落ち着く
    前提 "local/verification" の作業ツリーが clean である
    もし ローカル動作確認を終了する
    ならば 必要に応じて "repo/" を "main" に戻す

  シナリオ: マージ前に対象ブランチが更新された
    もし 対象ブランチに新しいコミットが追加される
    ならば 対象ブランチを作業ブランチへ取り込む
    かつ 競合は作業ブランチ上で解消する
\`\`\`
EOF

cat > "${SCRIPT_DIR}/${dir_name}/WORKTREES.md" <<EOF
# ${dir_name} worktree 運用

\`repo/\` は \`origin/main\` から分岐した \`local/verification\` 専用とする。
作業ブランチと、使用するリモートブランチは \`.worktrees/<ブランチ名>/\` に置く。

## 手順

1. \`./repos/setup_worktrees.sh ${dir_name}\` で既存ブランチを展開する。
2. 新規作業は最新の \`origin/main\` から \`.worktrees/<ブランチ名>/\` に作る。
3. 作業ブランチを \`repo/\` の \`local/verification\` にマージしてローカル動作確認する。
4. 検証が落ち着いたら \`repo/\` を clean にし、必要に応じて \`main\` へ戻す。

\`.worktrees/\` はローカル専用で Git 管理しない。一つのブランチを複数の worktree で開かない。
ブランチ固有の統合規約は [BRANCH.md](BRANCH.md) を参照する。
EOF

# --- アクセス権限テーブル更新 ----------------------------------------------

tmp_readme="$(mktemp "${README}.XXXXXX")"
trap 'rm -f "$tmp_readme"' EXIT

set +e
awk -v dir="$dir_name" -v pg="$project_group_perm" -v sm="$submodule_perm" '
function trim(s) {
  sub(/^[ \t]+/, "", s)
  sub(/[ \t]+$/, "", s)
  return s
}
# 空セルのみの行 (テーブルのプレースホルダ行) かどうか
function is_blank_row(line,   t) {
  t = line
  gsub(/[| \t]/, "", t)
  return t == ""
}
# 行の1列目 (submodule_dir) を取り出す
function row_key(line,   n, a) {
  n = split(line, a, "|")
  if (n < 2) return ""
  return trim(a[2])
}
{ lines[NR] = $0 }
END {
  # テーブルのヘッダ行を探す
  hdr = 0
  for (i = 1; i <= NR; i++) {
    if (lines[i] ~ /^[ \t]*\|[ \t]*submodule_dir[ \t]*\|/) { hdr = i; break }
  }
  if (hdr == 0) exit 2

  # テーブルの最終行 (先頭が | である連続行の終わり)
  last = hdr
  for (i = hdr + 1; i <= NR; i++) {
    if (lines[i] ~ /^[ \t]*\|/) last = i; else break
  }

  newrow = "| " dir " | " pg " | " sm " |"
  done = 0
  for (i = 1; i <= NR; i++) {
    if (i >= hdr + 2 && i <= last) {
      # 同名の行があれば置き換える
      if (row_key(lines[i]) == dir) { print newrow; done = 1; continue }
      # 空セルのみのプレースホルダ行は除去する
      # (| <例> | rwx | rwx | のような書式サンプル行はそのまま残す)
      if (is_blank_row(lines[i])) continue
    }
    if (i == last + 1 && !done) { print newrow; done = 1 }
    print lines[i]
  }
  if (!done) print newrow
}
' "$README" > "$tmp_readme"
awk_status=$?
set -e

(( awk_status == 0 )) || die "README.mdの更新に失敗しました"

cat "$tmp_readme" > "$README"
rm -f "$tmp_readme"
trap - EXIT

git -C "$repo_root" add -- "$README" \
  "${SCRIPT_DIR}/${dir_name}/MEMORY.md" \
  "${SCRIPT_DIR}/${dir_name}/BRANCH.md" \
  "${SCRIPT_DIR}/${dir_name}/WORKTREES.md"

printf 'アクセス権限テーブルを更新しました: | %s | %s | %s |\n' \
  "$dir_name" "$project_group_perm" "$submodule_perm"
printf '変更はステージ済みです。内容を確認してcommitしてください。\n'
