#!/usr/bin/env bash
#
# タスクの完了条件と、手順書のシナリオ ID が 1:1 で対応しているかを検証する。
#
# 使い方:
#   ./.claude/skills/verify-task/check_scenario_ids.sh <タスクの md>
#
# 対応の取り方:
#   タスク md の frontmatter `test:` に書かれたパス (docs/feature/ 配下のファイルか
#   ディレクトリ) から `@P-1-1` 形式のタグを集め、タスク md の本文から
#   `**P-1-1**` 形式の見出しを集めて突き合わせる。
#   `_` で始まる feature (共通の前提) は実行対象ではないので数えない。
#
# 終了コード:
#   0 = 一致  /  1 = 不一致か引数の誤り

set -euo pipefail

if (( $# < 1 )); then
  printf '使い方: check_scenario_ids.sh <タスクの md>\n' >&2
  exit 1
fi

task="$1"

if [[ ! -f "$task" ]]; then
  printf 'error: ファイルが見つかりません: %s\n' "$task" >&2
  exit 1
fi

# リポジトリルート基準でパスを解決する (frontmatter の test: はルート相対)
root="$(git -C "$(dirname "$task")" rev-parse --show-toplevel)"

# frontmatter の test: から `  - <パス>` を集める
paths="$(
  awk '
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---"   { exit }
    in_fm && /^test:/      { in_test = 1; next }
    in_test && /^  *- /    { sub(/^  *- /, ""); sub(/[ \t]+#.*$/, ""); print; next }
    in_test && /^[^ ]/     { exit }
  ' "$task"
)"

if [[ -z "$paths" ]]; then
  printf 'error: frontmatter に test: が無いか空です: %s\n' "$task" >&2
  exit 1
fi

# test: の各パスを feature ファイルの一覧に展開する
features=()
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  full="$root/${p%/}"
  if [[ -d "$full" ]]; then
    while IFS= read -r f; do
      features+=("$f")
    done < <(find "$full" -maxdepth 1 -name '*.feature' -not -name '_*' | sort)
  elif [[ -f "$full" ]]; then
    features+=("$full")
  else
    printf 'error: test: のパスが見つかりません: %s\n' "$p" >&2
    exit 1
  fi
done <<< "$paths"

if (( ${#features[@]} == 0 )); then
  printf 'error: 実行対象の feature が 1 つもありません (`_` 以外の .feature が無い)\n' >&2
  exit 1
fi

# grep の「一致なし」(1) は空集合として扱い、件数と不足 ID を報告する。
# set -e / pipefail に任せると、シナリオ ID が無いとき無言で終了してしまう。
# 読み取りエラー (2 以上) は握り潰さない。
in_feature="$( { grep -ho '@[A-Z]-[0-9]\{1,\}-[0-9]\{1,\}' "${features[@]}" || test "$?" -eq 1; } | tr -d '@' | sort -u)"
in_task="$( { grep -o '\*\*[A-Z]-[0-9]\{1,\}-[0-9]\{1,\}\*\*' "$task" || test "$?" -eq 1; } | tr -d '*' | sort -u)"

only_feature="$(comm -23 <(printf '%s\n' "$in_feature") <(printf '%s\n' "$in_task"))"
only_task="$(comm -13 <(printf '%s\n' "$in_feature") <(printf '%s\n' "$in_task"))"

printf '手順書: %d ファイル / %d シナリオ\n' \
  "${#features[@]}" "$(printf '%s\n' "$in_feature" | grep -c . || true)"
printf 'タスク: %d チェック\n' "$(printf '%s\n' "$in_task" | grep -c . || true)"

status=0

if [[ -z "$in_feature" ]]; then
  printf '\n手順書にシナリオ ID がありません。@P-1-1 形式のタグを確認してください。\n' >&2
  status=1
fi

if [[ -z "$in_task" ]]; then
  printf '\nタスクにシナリオ ID がありません。**P-1-1** 形式の完了条件を確認してください。\n' >&2
  status=1
fi

if [[ -n "$only_feature" ]]; then
  printf '\n完了条件に無いシナリオ:\n' >&2
  printf '  %s\n' $only_feature >&2
  status=1
fi

if [[ -n "$only_task" ]]; then
  printf '\n手順書に無いチェック:\n' >&2
  printf '  %s\n' $only_task >&2
  status=1
fi

if (( status == 0 )); then
  printf '\n1:1 で対応している\n'
fi

exit "$status"
