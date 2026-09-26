#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  printf '使い方: %s <job名> <タスクIDまたは名前> <変更後状態> [blockedBy]\n' "${0##*/}" >&2
  printf '状態: todo | pending | progress | done\n' >&2
  printf '例: %s PROJ-123 T-003 progress\n' "${0##*/}" >&2
  printf '例: %s PROJ-123 T-003 pending qa/Q-001\n' "${0##*/}" >&2
}

if (( $# < 3 || $# > 4 )); then
  usage
  exit 2
fi

job_name="$1"
task_selector="$2"
new_status="$3"
blocked_by="${4:-}"

if [[ -z "$job_name" || "$job_name" == */* || "$job_name" == "." || "$job_name" == ".." ]]; then
  printf 'error: job名だけを指定してください: %s\n' "$job_name" >&2
  exit 2
fi
if [[ ! "$task_selector" =~ ^T-[0-9]{3,}$ && ! "$task_selector" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  printf 'error: タスクIDまたは名前の形式が不正です: %s\n' "$task_selector" >&2
  exit 2
fi
case "$new_status" in
  todo|pending|progress|done) ;;
  *)
    printf 'error: 状態はtodo、pending、progress、doneのいずれかです: %s\n' "$new_status" >&2
    exit 2
    ;;
esac
if [[ "$blocked_by" == *$'\n'* ]]; then
  printf 'error: blockedByは1行で指定してください\n' >&2
  exit 2
fi
if [[ "$new_status" == "pending" && -z "$blocked_by" ]]; then
  printf 'error: pendingにはblockedByが必要です\n' >&2
  exit 2
fi
if [[ "$new_status" != "pending" && -n "$blocked_by" ]]; then
  printf 'error: blockedByを指定できるのはpendingへの変更時だけです\n' >&2
  exit 2
fi

job_dir="$script_dir/$job_name"
list_dir="$job_dir/list"
if [[ ! -d "$list_dir" ]]; then
  printf 'error: jobが見つかりません: %s\n' "$job_name" >&2
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

task_file=""
if [[ "$task_selector" =~ ^T-[0-9]{3,}$ ]]; then
  match_count=0
  task_files=("$list_dir"/*.md)
  for candidate_file in "${task_files[@]}"; do
    [[ -f "$candidate_file" && "${candidate_file##*/}" != "template.md" ]] || continue
    [[ "$(frontmatter_field "$candidate_file" id)" == "$task_selector" ]] || continue
    task_file="$candidate_file"
    match_count=$((match_count + 1))
  done
  if (( match_count == 0 )); then
    printf 'error: タスクIDが見つかりません: %s\n' "$task_selector" >&2
    exit 1
  fi
  if (( match_count > 1 )); then
    printf 'error: タスクIDが重複しています: %s\n' "$task_selector" >&2
    exit 1
  fi
else
  task_file="$list_dir/$task_selector.md"
  if [[ ! -f "$task_file" ]]; then
    printf 'error: タスクが見つかりません: %s\n' "$task_file" >&2
    exit 1
  fi
fi

task_name="${task_file##*/}"
task_name="${task_name%.md}"
task_id="$(frontmatter_field "$task_file" id)"
if [[ ! "$task_id" =~ ^T-[0-9]{3,}$ ]]; then
  printf 'error: タスクIDが未設定または不正です: %s (%s)\n' "$task_file" "${task_id:-未設定}" >&2
  exit 1
fi
id_match_count=0
task_files=("$list_dir"/*.md)
for candidate_file in "${task_files[@]}"; do
  [[ -f "$candidate_file" && "${candidate_file##*/}" != "template.md" ]] || continue
  [[ "$(frontmatter_field "$candidate_file" id)" == "$task_id" ]] || continue
  id_match_count=$((id_match_count + 1))
done
if (( id_match_count > 1 )); then
  printf 'error: タスクIDが重複しています: %s\n' "$task_id" >&2
  exit 1
fi

for status_dir_name in todo pending progress done; do
  if [[ ! -d "$job_dir/status/$status_dir_name" ]]; then
    printf 'error: 状態ディレクトリが見つかりません: %s\n' "$job_dir/status/$status_dir_name" >&2
    exit 1
  fi
done

old_status="$(frontmatter_field "$task_file" status)"
case "$old_status" in
  todo|pending|progress|done) ;;
  *)
    printf 'error: 実体のstatusが不正です: %s\n' "${old_status:-未設定}" >&2
    exit 1
    ;;
esac

for required_field in updatedAt completedAt blockedBy; do
  if ! sed -n '2,/^---$/p' "$task_file" | rg -q "^${required_field}:"; then
    printf 'error: frontmatterに%sがありません: %s\n' "$required_field" "$task_file" >&2
    exit 1
  fi
done

expected_target="../../list/$task_name.md"
link_source=""
link_count=0
for status_dir_name in todo pending progress done; do
  candidate="$job_dir/status/$status_dir_name/$task_name.md"
  if [[ -L "$candidate" ]]; then
    actual_target="$(readlink "$candidate")"
    if [[ "$actual_target" != "$expected_target" ]]; then
      printf 'error: 状態索引のリンク先が不正です: %s -> %s\n' "$candidate" "$actual_target" >&2
      exit 1
    fi
    link_source="$candidate"
    link_count=$((link_count + 1))
  elif [[ -e "$candidate" ]]; then
    printf 'error: 状態索引に通常ファイルがあります: %s\n' "$candidate" >&2
    exit 1
  fi
done
if (( link_count > 1 )); then
  printf 'error: 同じタスクの状態索引が複数あります: %s\n' "$task_name" >&2
  exit 1
fi

new_index="$job_dir/status/$new_status/$task_name.md"
updated_at="$(date +%F)"
temp_file="$(mktemp "$job_dir/list/.task-transition.XXXXXX")"
link_action="none"
committed=0

cleanup() {
  [[ ! -e "$temp_file" ]] || rm -f "$temp_file"
  if (( committed == 0 )); then
    case "$link_action" in
      move) mv "$new_index" "$link_source" 2>/dev/null || true ;;
      create) rm -f "$new_index" ;;
    esac
  fi
}
trap cleanup EXIT

awk -v new_status="$new_status" -v updated_at="$updated_at" -v blocked_by="$blocked_by" '
  NR == 1 && $0 == "---" { in_frontmatter = 1; print; next }
  in_frontmatter && $0 == "---" { in_frontmatter = 0; print; next }
  in_frontmatter {
    if (skip_blocked) {
      if ($0 ~ /^[[:space:]]*-[[:space:]]+/) next
      skip_blocked = 0
    }
    if ($0 ~ /^status:/) {
      print "status: " new_status
      next
    }
    if ($0 ~ /^updatedAt:/) {
      print "updatedAt: " updated_at
      next
    }
    if ($0 ~ /^completedAt:/) {
      if (new_status == "done") print "completedAt: " updated_at
      else print "completedAt:"
      next
    }
    if ($0 ~ /^blockedBy:/) {
      if ($0 ~ /^blockedBy:[[:space:]]*$/) skip_blocked = 1
      if (new_status == "pending") {
        print "blockedBy:"
        print "  - " blocked_by
      } else {
        print "blockedBy: []"
      }
      next
    }
  }
  { print }
' "$task_file" > "$temp_file"

file_mode="$(stat -f '%Lp' "$task_file" 2>/dev/null || true)"
if [[ ! "$file_mode" =~ ^[0-7]+$ ]]; then
  file_mode="$(stat -c '%a' "$task_file")"
fi
chmod "$file_mode" "$temp_file"

if [[ -n "$link_source" && "$link_source" != "$new_index" ]]; then
  mv "$link_source" "$new_index"
  link_action="move"
elif [[ -z "$link_source" ]]; then
  ln -s "$expected_target" "$new_index"
  link_action="create"
fi

mv "$temp_file" "$task_file"
committed=1
trap - EXIT

printf '変更: %s / %s / %s -> %s\n' "$task_id" "$task_name" "$old_status" "$new_status"
printf '実体: job/%s/list/%s.md\n' "$job_name" "$task_name"
printf '索引: job/%s/status/%s/%s.md -> %s\n' \
  "$job_name" "$new_status" "$task_name" "$(readlink "$new_index")"
