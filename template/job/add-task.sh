#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  printf '使い方: %s <job名> <タスク名> <状態> <タイトル> [blockedBy]\n' "${0##*/}" >&2
  printf '状態: todo | progress | pending\n' >&2
  printf '例: %s PROJ-123 check-prod-data todo "本番データを確認する"\n' "${0##*/}" >&2
  printf '例: %s PROJ-123 await-answer pending "回答後に方針を決める" qa/Q-001\n' "${0##*/}" >&2
}

if (( $# < 4 || $# > 5 )); then
  usage
  exit 2
fi

job_name="$1"
task_name="$2"
status="$3"
title="$4"
blocked_by="${5:-}"

if [[ -z "$job_name" || "$job_name" == */* || "$job_name" == "." || "$job_name" == ".." ]]; then
  printf 'error: job名だけを指定してください: %s\n' "$job_name" >&2
  exit 2
fi
if [[ ! "$task_name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  printf 'error: タスク名は英小文字・数字・ハイフンで指定してください: %s\n' "$task_name" >&2
  exit 2
fi
case "$status" in
  todo|progress|pending) ;;
  *)
    printf 'error: 初期状態は todo、progress、pendingのいずれかです: %s\n' "$status" >&2
    exit 2
    ;;
esac
if [[ -z "$title" || "$title" == *$'\n'* ]]; then
  printf 'error: タイトルは空でない1行で指定してください\n' >&2
  exit 2
fi
if [[ "$blocked_by" == *$'\n'* ]]; then
  printf 'error: blockedByは1行で指定してください\n' >&2
  exit 2
fi
if [[ "$status" == "pending" && -z "$blocked_by" ]]; then
  printf 'error: pendingにはblockedByが必要です\n' >&2
  exit 2
fi
if [[ "$status" != "pending" && -n "$blocked_by" ]]; then
  printf 'error: blockedByを指定する場合、初期状態はpendingにしてください\n' >&2
  exit 2
fi

job_dir="$script_dir/$job_name"
list_dir="$job_dir/list"
status_dir="$job_dir/status/$status"
if [[ ! -d "$list_dir" || ! -d "$status_dir" ]]; then
  printf 'error: 既存のjobが見つからないか、構成が不完全です: %s\n' "$job_name" >&2
  exit 1
fi

task_file="$list_dir/$task_name.md"
index_file="$status_dir/$task_name.md"
if [[ -e "$task_file" || -L "$task_file" ]]; then
  printf 'error: 同名のタスクが存在します: %s\n' "$task_file" >&2
  exit 1
fi

for candidate_status in todo pending progress done; do
  candidate="$job_dir/status/$candidate_status/$task_name.md"
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
  if [[ ! "$existing_id" =~ ^T-[0-9]{3,}$ ]]; then
    printf 'error: 既存タスクのIDが未設定または不正です: %s (%s)\n' \
      "$existing_file" "${existing_id:-未設定}" >&2
    exit 1
  fi
  if [[ "$seen_ids" == *"|$existing_id|"* ]]; then
    printf 'error: タスクIDが重複しています: %s\n' "$existing_id" >&2
    exit 1
  fi
  seen_ids="${seen_ids}|${existing_id}|"
  id_number="${existing_id#T-}"
  id_number=$((10#$id_number))
  (( id_number <= max_id )) || max_id="$id_number"
done
printf -v task_id 'T-%03d' "$((max_id + 1))"

created_at="$(date +%F)"
temp_file="$(mktemp "$list_dir/.add-task.XXXXXX")"

cleanup() {
  [[ ! -e "$temp_file" ]] || rm -f "$temp_file"
}
trap cleanup EXIT

{
  printf '%s\n' '---'
  printf 'id: %s\n' "$task_id"
  printf 'status: %s\n' "$status"
  printf 'createdAt: %s\n' "$created_at"
  printf 'updatedAt: %s\n' "$created_at"
  printf '%s\n' 'completedAt:'
  if [[ -n "$blocked_by" ]]; then
    printf '%s\n' 'blockedBy:'
    printf '  - %s\n' "$blocked_by"
  else
    printf '%s\n' 'blockedBy: []'
  fi
  printf '%s\n' 'test: []'
  printf '%s\n\n' '---'
  printf '%s\n\n' '# 計画'
  printf '%s\n\n' '## タイトル'
  printf '%s\n\n' "$title"
  printf '%s\n\n' '## 内容'
  printf '%s\n\n' "$title"
  printf '%s\n\n' '## 完了条件'
  printf '%s\n\n' '* [ ] 上記の作業を完了し、結果を記録する'
  printf '%s\n\n' '## ログ'
  printf '%s\n\n' '### フェーズ'
  printf '%s\n\n' '#### 計画'
  printf '%s\n\n' '#### 実施内容'
  printf '%s\n' '## 結果'
} > "$temp_file"

chmod 644 "$temp_file"
mv "$temp_file" "$task_file"
if ! ln -s "../../list/$task_name.md" "$index_file"; then
  rm -f "$task_file"
  exit 1
fi

trap - EXIT
printf '作成: %s / job/%s/list/%s.md\n' "$task_id" "$job_name" "$task_name"
printf '索引: job/%s/status/%s/%s.md -> %s\n' \
  "$job_name" "$status" "$task_name" "$(readlink "$index_file")"
printf '%s\n' '内容・完了条件・testは必要に応じて実体ファイルを編集してください。'
