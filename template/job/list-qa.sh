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

question_summary() {
  awk '
    $0 == "## 質問内容" { in_question = 1; next }
    in_question && /^## / { exit }
    in_question && NF { print; exit }
  ' "$1"
}

qa_files=("$list_dir"/*.md)

count_status() {
  local expected_status="$1"
  local count=0
  local file status

  for file in "${qa_files[@]}"; do
    [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
    status="$(frontmatter_field "$file" status)"
    [[ "$status" == "$expected_status" ]] && count=$((count + 1))
  done
  printf '%d' "$count"
}

print_status() {
  local expected_status="$1"
  local count file status qa_id qa_name summary ask_to

  count="$(count_status "$expected_status")"
  printf '  %s (%s)\n' "$expected_status" "$count"

  for file in "${qa_files[@]}"; do
    [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
    status="$(frontmatter_field "$file" status)"
    [[ "$status" == "$expected_status" ]] || continue

    qa_name="${file##*/}"
    qa_name="${qa_name%.md}"
    qa_id="$(frontmatter_field "$file" id)"
    [[ -n "$qa_id" ]] || qa_id="ID未設定"
    summary="$(question_summary "$file")"
    [[ -n "$summary" ]] || summary="$qa_name"
    ask_to="$(frontmatter_field "$file" askTo)"
    printf '    %-8s %-40s %s (%s)\n' "$qa_id" "$qa_name" "$summary" "${ask_to:-確認先未設定}"
  done
}

total=0
unknown=0
for file in "${qa_files[@]}"; do
  [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
  total=$((total + 1))
  status="$(frontmatter_field "$file" status)"
  case "$status" in
    unresolved|resolved) ;;
    *) unknown=$((unknown + 1)) ;;
  esac
done

printf '%s QA (job/%s/qa/)\n' "$job_name" "$job_name"
for status in unresolved resolved; do
  print_status "$status"
done

if (( unknown > 0 )); then
  printf '  unknown (%d)\n' "$unknown"
  for file in "${qa_files[@]}"; do
    [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
    status="$(frontmatter_field "$file" status)"
    case "$status" in
      unresolved|resolved) continue ;;
    esac
    qa_id="$(frontmatter_field "$file" id)"
    printf '    %-8s %s (status: %s)\n' "${qa_id:-ID未設定}" "${file##*/}" "${status:-未設定}"
  done
fi

printf '  合計: %d\n' "$total"

id_issues=0
for ((i = 0; i < ${#qa_files[@]}; i++)); do
  file="${qa_files[$i]}"
  [[ -f "$file" && "${file##*/}" != "template.md" ]] || continue
  qa_id="$(frontmatter_field "$file" id)"
  if [[ ! "$qa_id" =~ ^Q-[0-9]{3,}$ ]]; then
    (( id_issues > 0 )) || printf '%s\n' '  要確認:'
    printf '    IDが未設定または不正: %s (%s)\n' "${file##*/}" "${qa_id:-未設定}"
    id_issues=$((id_issues + 1))
    continue
  fi
  for ((j = i + 1; j < ${#qa_files[@]}; j++)); do
    candidate="${qa_files[$j]}"
    [[ -f "$candidate" && "${candidate##*/}" != "template.md" ]] || continue
    [[ "$(frontmatter_field "$candidate" id)" == "$qa_id" ]] || continue
    (( id_issues > 0 )) || printf '%s\n' '  要確認:'
    printf '    ID重複: %s (%s, %s)\n' "$qa_id" "${file##*/}" "${candidate##*/}"
    id_issues=$((id_issues + 1))
  done
done
