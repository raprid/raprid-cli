#!/usr/bin/env bash
#
# submodule の主作業ツリーを local/verification にし、使用中のブランチを
# repos/<名前>/.worktrees/<ブランチ名>/ に展開する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERIFICATION_BRANCH="local/verification"

usage() {
  cat <<'EOS'
使い方:
  ./repos/setup_worktrees.sh <リポジトリ名> [ブランチ名 ...]

ブランチ名を省略すると、既存のローカルブランチと、origin に存在する
main / dev / stg / prod を対象にする。local/verification は repo/ で使う。
EOS
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 1
fi
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 0
fi

repo_name="$1"
shift
wrapper_dir="${SCRIPT_DIR}/${repo_name}"
repo_dir="${wrapper_dir}/repo"
worktrees_dir="${wrapper_dir}/.worktrees"

[[ "$repo_name" != */* ]] || die "リポジトリ名に / は使えません: $repo_name"
[[ -d "$repo_dir" ]] || die "submodule が見つかりません: $repo_dir"
git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1 || die "Git リポジトリではありません: $repo_dir"
git -C "$repo_dir" show-ref --verify --quiet refs/remotes/origin/main \
  || die "origin/main が見つかりません"

# git submodule add 後の absorbed gitdir は core.worktree を共通 config に持つ。
# worktree を増やす前に主作業ツリー固有の config へ移し、linked worktree へ漏らさない。
core_worktree="$(git -C "$repo_dir" config --local --get core.worktree 2>/dev/null || true)"
if [[ -n "$core_worktree" ]]; then
  git -C "$repo_dir" config extensions.worktreeConfig true
  git -C "$repo_dir" config --local --unset core.worktree
  git -C "$repo_dir" config --worktree core.worktree "$core_worktree"
fi

mkdir -p "$worktrees_dir"
git -C "$repo_dir" worktree prune

current_branch="$(git -C "$repo_dir" branch --show-current)"
if [[ "$current_branch" != "$VERIFICATION_BRANCH" ]]; then
  if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
    die "repo/ に未コミット変更があります。保持方法を決めてから $VERIFICATION_BRANCH へ切り替えてください"
  fi
  if git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$VERIFICATION_BRANCH"; then
    git -C "$repo_dir" switch "$VERIFICATION_BRANCH"
  else
    git -C "$repo_dir" switch -c "$VERIFICATION_BRANCH" origin/main
  fi
fi

git -C "$repo_dir" merge-base --is-ancestor origin/main "$VERIFICATION_BRANCH" \
  || die "$VERIFICATION_BRANCH は現在の origin/main から分岐した履歴ではありません"
git -C "$repo_dir" branch --unset-upstream "$VERIFICATION_BRANCH" 2>/dev/null || true

if [[ $# -gt 0 ]]; then
  branch_list="$(printf '%s\n' "$@" | sed '/^$/d' | sort -u)"
else
  branch_list="$({
    git -C "$repo_dir" for-each-ref --format='%(refname:short)' refs/heads \
      | sed "\|^${VERIFICATION_BRANCH}$|d"
    for branch_name in main dev stg prod; do
      if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$branch_name"; then
        printf '%s\n' "$branch_name"
      fi
    done
  } | sed '/^$/d' | sort -u)"
fi

while IFS= read -r branch_name; do
  [[ -n "$branch_name" ]] || continue
  [[ "$branch_name" != "$VERIFICATION_BRANCH" ]] \
    || die "$VERIFICATION_BRANCH は .worktrees/ ではなく repo/ で使います"

  remote_ref="refs/remotes/origin/${branch_name}"
  local_ref="refs/heads/${branch_name}"
  registered_path="$(git -C "$repo_dir" worktree list --porcelain | awk -v ref="refs/heads/$branch_name" '
    $1 == "worktree" { path = substr($0, 10) }
    $1 == "branch" && $2 == ref { print path }
  ')"

  if [[ -n "$registered_path" ]]; then
    printf '既存: %s -> %s\n' "$branch_name" "$registered_path"
    continue
  fi

  if git -C "$repo_dir" show-ref --verify --quiet "$local_ref"; then
    if git -C "$repo_dir" show-ref --verify --quiet "$remote_ref" \
      && git -C "$repo_dir" merge-base --is-ancestor "$local_ref" "$remote_ref"; then
      git -C "$repo_dir" branch -f "$branch_name" "origin/$branch_name" >/dev/null
    fi
  elif git -C "$repo_dir" show-ref --verify --quiet "$remote_ref"; then
    git -C "$repo_dir" branch --track "$branch_name" "origin/$branch_name" >/dev/null
  else
    die "ローカルにも origin にもブランチがありません: $branch_name"
  fi

  target_path="${worktrees_dir}/${branch_name}"
  [[ ! -e "$target_path" ]] || die "未登録のパスが既に存在します: $target_path"

  mkdir -p "$(dirname "$target_path")"
  git -C "$repo_dir" worktree add "$target_path" "$branch_name"
done <<< "$branch_list"

printf '\n主作業ツリー: %s (%s)\n' "$repo_dir" "$VERIFICATION_BRANCH"
git -C "$repo_dir" worktree list
