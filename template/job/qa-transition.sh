#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  printf '使い方: %s <job名> <QA IDまたは名前> unresolved\n' "${0##*/}" >&2
  printf '        %s <job名> <QA IDまたは名前> resolved <回答>\n' "${0##*/}" >&2
  printf '例: %s PROJ-123 Q-001 resolved "確認環境から実行する"\n' "${0##*/}" >&2
}

if (( $# < 3 || $# > 4 )); then
  usage
  exit 2
fi

job_name="$1"
qa_selector="$2"
new_status="$3"
answer="${4:-}"

if [[ -z "$job_name" || "$job_name" == */* || "$job_name" == "." || "$job_name" == ".." ]]; then
  printf 'error: job名だけを指定してください: %s\n' "$job_name" >&2
  exit 2
fi
if [[ ! "$qa_selector" =~ ^Q-[0-9]{3,}$ && ! "$qa_selector" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  printf 'error: QA IDまたは名前の形式が不正です: %s\n' "$qa_selector" >&2
  exit 2
fi
case "$new_status" in
  unresolved)
    if (( $# != 3 )); then
      printf 'error: unresolvedへの変更では回答を指定しません\n' >&2
      exit 2
    fi
    ;;
  resolved)
    if (( $# != 4 )) || [[ -z "$answer" || "$answer" == *$'\n'* ]]; then
      printf 'error: resolvedへの変更には空でない1行の回答が必要です\n' >&2
      exit 2
    fi
    ;;
  *)
    printf 'error: 状態はunresolvedまたはresolvedです: %s\n' "$new_status" >&2
    exit 2
    ;;
esac

job_dir="$script_dir/$job_name"
list_dir="$job_dir/qa/list"
if [[ ! -d "$list_dir" ]]; then
  printf 'error: QAを管理するjobが見つかりません: %s\n' "$job_name" >&2
  exit 1
fi

frontmatter_field() {
  local file="$1"
  local field="$2"

  awk -v field="$field" '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter && index($0, field ":") == 1 {
      value = substr($0, length(field) + 2)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "$file"
}

qa_file=""
if [[ "$qa_selector" =~ ^Q-[0-9]{3,}$ ]]; then
  match_count=0
  qa_files=("$list_dir"/*.md)
  for candidate_file in "${qa_files[@]}"; do
    [[ -f "$candidate_file" && "${candidate_file##*/}" != "template.md" ]] || continue
    [[ "$(frontmatter_field "$candidate_file" id)" == "$qa_selector" ]] || continue
    qa_file="$candidate_file"
    match_count=$((match_count + 1))
  done
  if (( match_count == 0 )); then
    printf 'error: QA IDが見つかりません: %s\n' "$qa_selector" >&2
    exit 1
  fi
  if (( match_count > 1 )); then
    printf 'error: QA IDが重複しています: %s\n' "$qa_selector" >&2
    exit 1
  fi
else
  qa_file="$list_dir/$qa_selector.md"
  if [[ ! -f "$qa_file" ]]; then
    printf 'error: QAが見つかりません: %s\n' "$qa_file" >&2
    exit 1
  fi
fi

qa_name="${qa_file##*/}"
qa_name="${qa_name%.md}"
qa_id="$(frontmatter_field "$qa_file" id)"
if [[ ! "$qa_id" =~ ^Q-[0-9]{3,}$ ]]; then
  printf 'error: QA IDが未設定または不正です: %s (%s)\n' "$qa_file" "${qa_id:-未設定}" >&2
  exit 1
fi
id_match_count=0
qa_files=("$list_dir"/*.md)
for candidate_file in "${qa_files[@]}"; do
  [[ -f "$candidate_file" && "${candidate_file##*/}" != "template.md" ]] || continue
  [[ "$(frontmatter_field "$candidate_file" id)" == "$qa_id" ]] || continue
  id_match_count=$((id_match_count + 1))
done
if (( id_match_count > 1 )); then
  printf 'error: QA IDが重複しています: %s\n' "$qa_id" >&2
  exit 1
fi

for status_dir_name in unresolved resolved; do
  if [[ ! -d "$job_dir/qa/status/$status_dir_name" ]]; then
    printf 'error: QA状態ディレクトリが見つかりません: %s\n' "$job_dir/qa/status/$status_dir_name" >&2
    exit 1
  fi
done

old_status="$(frontmatter_field "$qa_file" status)"
case "$old_status" in
  unresolved|resolved) ;;
  *)
    printf 'error: 実体のstatusが不正です: %s\n' "${old_status:-未設定}" >&2
    exit 1
    ;;
esac

for required_field in updatedAt resolvedAt; do
  if ! sed -n '2,/^---$/p' "$qa_file" | rg -q "^${required_field}:"; then
    printf 'error: frontmatterに%sがありません: %s\n' "$required_field" "$qa_file" >&2
    exit 1
  fi
done
if ! rg -q '^## 回答内容$' "$qa_file"; then
  printf 'error: 回答内容の見出しがありません: %s\n' "$qa_file" >&2
  exit 1
fi

expected_target="../../list/$qa_name.md"
link_source=""
link_count=0
for status_dir_name in unresolved resolved; do
  candidate="$job_dir/qa/status/$status_dir_name/$qa_name.md"
  if [[ -L "$candidate" ]]; then
    actual_target="$(readlink "$candidate")"
    if [[ "$actual_target" != "$expected_target" ]]; then
      printf 'error: QA状態索引のリンク先が不正です: %s -> %s\n' "$candidate" "$actual_target" >&2
      exit 1
    fi
    link_source="$candidate"
    link_count=$((link_count + 1))
  elif [[ -e "$candidate" ]]; then
    printf 'error: QA状態索引に通常ファイルがあります: %s\n' "$candidate" >&2
    exit 1
  fi
done
if (( link_count > 1 )); then
  printf 'error: 同じQAの状態索引が複数あります: %s\n' "$qa_name" >&2
  exit 1
fi

new_index="$job_dir/qa/status/$new_status/$qa_name.md"
updated_at="$(date +%F)"
frontmatter_temp="$(mktemp "$job_dir/qa/list/.qa-transition-frontmatter.XXXXXX")"
temp_file="$(mktemp "$job_dir/qa/list/.qa-transition.XXXXXX")"
link_action="none"
committed=0

cleanup() {
  [[ ! -e "$frontmatter_temp" ]] || rm -f "$frontmatter_temp"
  [[ ! -e "$temp_file" ]] || rm -f "$temp_file"
  if (( committed == 0 )); then
    case "$link_action" in
      move) mv "$new_index" "$link_source" 2>/dev/null || true ;;
      create) rm -f "$new_index" ;;
    esac
  fi
}
trap cleanup EXIT

awk -v new_status="$new_status" -v updated_at="$updated_at" '
  NR == 1 && $0 == "---" { in_frontmatter = 1; print; next }
  in_frontmatter && $0 == "---" { in_frontmatter = 0; print; next }
  in_frontmatter && skip_blocked {
    if ($0 ~ /^[[:space:]]*-[[:space:]]+/) next
    skip_blocked = 0
  }
  in_frontmatter && $0 ~ /^status:/ {
    print "status: " new_status
    next
  }
  in_frontmatter && $0 ~ /^updatedAt:/ {
    print "updatedAt: " updated_at
    next
  }
  in_frontmatter && $0 ~ /^resolvedAt:/ {
    if (new_status == "resolved") print "resolvedAt: " updated_at
    else print "resolvedAt:"
    next
  }
  in_frontmatter && new_status == "resolved" && $0 ~ /^blockedBy:/ {
    if ($0 ~ /^blockedBy:[[:space:]]*$/) skip_blocked = 1
    print "blockedBy: []"
    next
  }
  { print }
' "$qa_file" > "$frontmatter_temp"

if [[ "$new_status" == "resolved" ]]; then
  awk -v answer="$answer" '
    $0 == "## 回答内容" {
      print
      print ""
      print answer
      in_answer_start = 1
      next
    }
    in_answer_start {
      if ($0 == "") next
      if ($0 == "未回答" || $0 == "未回答。") {
        in_answer_start = 0
        next
      }
      print ""
      in_answer_start = 0
    }
    { print }
  ' "$frontmatter_temp" > "$temp_file"
else
  cp "$frontmatter_temp" "$temp_file"
fi

file_mode="$(stat -f '%Lp' "$qa_file" 2>/dev/null || true)"
if [[ ! "$file_mode" =~ ^[0-7]+$ ]]; then
  file_mode="$(stat -c '%a' "$qa_file")"
fi
chmod "$file_mode" "$temp_file"

if [[ -n "$link_source" && "$link_source" != "$new_index" ]]; then
  mv "$link_source" "$new_index"
  link_action="move"
elif [[ -z "$link_source" ]]; then
  ln -s "$expected_target" "$new_index"
  link_action="create"
fi

mv "$temp_file" "$qa_file"
rm -f "$frontmatter_temp"
committed=1
trap - EXIT

printf '変更: %s / %s / %s -> %s\n' "$qa_id" "$qa_name" "$old_status" "$new_status"
printf '実体: job/%s/qa/list/%s.md\n' "$job_name" "$qa_name"
printf '索引: job/%s/qa/status/%s/%s.md -> %s\n' \
  "$job_name" "$new_status" "$qa_name" "$(readlink "$new_index")"
