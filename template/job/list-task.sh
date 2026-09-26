#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  printf '使い方: %s <job名>\n' "${0##*/}" >&2
  printf '例: %s PROJ-123\n' "${0##*/}" >&2
}

if (( $# != 1 )); then
  usage
  exit 2
fi

job_name="$1"
if [[ -z "$job_name" || "$job_name" == */* || "$job_name" == "." || "$job_name" == ".." ]]; then
  printf 'error: job名だけを指定してください: %s\n' "$job_name" >&2
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

task_title() {
  awk '
    $0 == "## タイトル" { in_title = 1; next }
    in_title && /^## / { exit }
    in_title && NF { print; exit }
  ' "$1"
}

task_files=("$list_dir"/*.md)

count_status() {
  local expected_status="$1"
  local count=0
  local file status

  for file in "${task_files[@]}"; do
    [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
    status="$(frontmatter_field "$file" status)"
    [[ "$status" == "$expected_status" ]] && count=$((count + 1))
  done
  printf '%d' "$count"
}

print_status() {
  local expected_status="$1"
  local count file status task_id task_name title

  count="$(count_status "$expected_status")"
  printf '  %s (%s)\n' "$expected_status" "$count"

  for file in "${task_files[@]}"; do
    [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
    status="$(frontmatter_field "$file" status)"
    [[ "$status" == "$expected_status" ]] || continue

    task_name="${file##*/}"
    task_name="${task_name%.md}"
    task_id="$(frontmatter_field "$file" id)"
    [[ -n "$task_id" ]] || task_id="ID未設定"
    title="$(task_title "$file")"
    [[ -n "$title" ]] || title="$task_name"
    printf '    %-8s %-40s %s\n' "$task_id" "$task_name" "$title"
  done
}

total=0
unknown=0
for file in "${task_files[@]}"; do
  [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
  total=$((total + 1))
  status="$(frontmatter_field "$file" status)"
  case "$status" in
    progress|todo|pending|done) ;;
    *) unknown=$((unknown + 1)) ;;
  esac
done

printf '%s (job/%s/)\n' "$job_name" "$job_name"
for status in progress todo pending done; do
  print_status "$status"
done

if (( unknown > 0 )); then
  printf '  unknown (%d)\n' "$unknown"
  for file in "${task_files[@]}"; do
    [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
    status="$(frontmatter_field "$file" status)"
    case "$status" in
      progress|todo|pending|done) continue ;;
    esac
    task_id="$(frontmatter_field "$file" id)"
    printf '    %-8s %s (status: %s)\n' "${task_id:-ID未設定}" "${file##*/}" "${status:-未設定}"
  done
fi

printf '  合計: %d\n' "$total"

id_issues=0
for ((i = 0; i < ${#task_files[@]}; i++)); do
  file="${task_files[$i]}"
  [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
  task_id="$(frontmatter_field "$file" id)"
  if [[ ! "$task_id" =~ ^T-[0-9]{3,}$ ]]; then
    (( id_issues > 0 )) || printf '%s\n' '  要確認:'
    printf '    IDが未設定または不正: %s (%s)\n' "${file##*/}" "${task_id:-未設定}"
    id_issues=$((id_issues + 1))
    continue
  fi
  for ((j = i + 1; j < ${#task_files[@]}; j++)); do
    candidate="${task_files[$j]}"
    [[ -f "$candidate" && "${candidate##*/}" != "template.md" ]] || continue
    [[ "$(frontmatter_field "$candidate" id)" == "$task_id" ]] || continue
    (( id_issues > 0 )) || printf '%s\n' '  要確認:'
    printf '    ID重複: %s (%s, %s)\n' "$task_id" "${file##*/}" "${candidate##*/}"
    id_issues=$((id_issues + 1))
  done
done
