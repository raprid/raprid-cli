#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  printf '使い方: %s <job名> <QA名> <確認先> <質問内容> [blockedBy]\n' "${0##*/}" >&2
  printf '確認先: customer | internal | undecided\n' >&2
  printf '例: %s PROJ-123 correction-policy customer "補正方法はこの方針でよいか"\n' "${0##*/}" >&2
}

if (( $# < 4 || $# > 5 )); then
  usage
  exit 2
fi

job_name="$1"
qa_name="$2"
ask_to="$3"
question="$4"
blocked_by="${5:-}"

if [[ -z "$job_name" || "$job_name" == */* || "$job_name" == "." || "$job_name" == ".." ]]; then
  printf 'error: job名だけを指定してください: %s\n' "$job_name" >&2
  exit 2
fi
if [[ ! "$qa_name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  printf 'error: QA名は英小文字・数字・ハイフンで指定してください: %s\n' "$qa_name" >&2
  exit 2
fi
case "$ask_to" in
  customer|internal|undecided) ;;
  *)
    printf 'error: 確認先はcustomer、internal、undecidedのいずれかです: %s\n' "$ask_to" >&2
    exit 2
    ;;
esac
if [[ -z "$question" || "$question" == *$'\n'* ]]; then
  printf 'error: 質問内容は空でない1行で指定してください\n' >&2
  exit 2
fi
if [[ "$blocked_by" == *$'\n'* ]]; then
  printf 'error: blockedByは1行で指定してください\n' >&2
  exit 2
fi

job_dir="$script_dir/$job_name"
list_dir="$job_dir/qa/list"
status_dir="$job_dir/qa/status/unresolved"
if [[ ! -d "$list_dir" || ! -d "$status_dir" ]]; then
  printf 'error: 既存のjobが見つからないか、QA構成が不完全です: %s\n' "$job_name" >&2
  exit 1
fi

qa_file="$list_dir/$qa_name.md"
index_file="$status_dir/$qa_name.md"
if [[ -e "$qa_file" || -L "$qa_file" ]]; then
  printf 'error: 同名のQAが存在します: %s\n' "$qa_file" >&2
  exit 1
fi

for candidate_status in unresolved resolved; do
  candidate="$job_dir/qa/status/$candidate_status/$qa_name.md"
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    printf 'error: 同名の状態索引が存在します: %s\n' "$candidate" >&2
    exit 1
  fi
done

frontmatter_id() {
  awk '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter && /^id:/ {
      value = substr($0, 4)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "$1"
}

max_id=0
seen_ids=""
existing_files=("$list_dir"/*.md)
for existing_file in "${existing_files[@]}"; do
  [[ -f "$existing_file" && "${existing_file##*/}" != "template.md" ]] || continue
  existing_id="$(frontmatter_id "$existing_file")"
  if [[ ! "$existing_id" =~ ^Q-[0-9]{3,}$ ]]; then
    printf 'error: 既存QAのIDが未設定または不正です: %s (%s)\n' \
      "$existing_file" "${existing_id:-未設定}" >&2
    exit 1
  fi
  if [[ "$seen_ids" == *"|$existing_id|"* ]]; then
    printf 'error: QA IDが重複しています: %s\n' "$existing_id" >&2
    exit 1
  fi
  seen_ids="${seen_ids}|${existing_id}|"
  id_number="${existing_id#Q-}"
  id_number=$((10#$id_number))
  (( id_number <= max_id )) || max_id="$id_number"
done
printf -v qa_id 'Q-%03d' "$((max_id + 1))"

created_at="$(date +%F)"
temp_file="$(mktemp "$list_dir/.add-qa.XXXXXX")"

cleanup() {
  [[ ! -e "$temp_file" ]] || rm -f "$temp_file"
}
trap cleanup EXIT

{
  printf '%s\n' '---'
  printf 'id: %s\n' "$qa_id"
  printf '%s\n' 'status: unresolved'
  printf 'createdAt: %s\n' "$created_at"
  printf 'updatedAt: %s\n' "$created_at"
  printf '%s\n' 'resolvedAt:'
  printf 'job: %s\n' "$job_name"
  printf 'askTo: %s\n' "$ask_to"
  if [[ -n "$blocked_by" ]]; then
    printf '%s\n' 'blockedBy:'
    printf '  - %s\n' "$blocked_by"
  else
    printf '%s\n' 'blockedBy: []'
  fi
  printf '%s\n\n' '---'
  printf '%s\n\n' '# Q&A'
  printf '%s\n\n' '## 質問内容'
  printf '%s\n\n' "$question"
  printf '%s\n' '## 回答内容'
} > "$temp_file"

chmod 644 "$temp_file"
mv "$temp_file" "$qa_file"
if ! ln -s "../../list/$qa_name.md" "$index_file"; then
  rm -f "$qa_file"
  exit 1
fi

trap - EXIT
printf '作成: %s / job/%s/qa/list/%s.md\n' "$qa_id" "$job_name" "$qa_name"
printf '索引: job/%s/qa/status/unresolved/%s.md -> %s\n' \
  "$job_name" "$qa_name" "$(readlink "$index_file")"
printf '%s\n' '補足や回答は必要に応じて実体ファイルへ追記してください。'
