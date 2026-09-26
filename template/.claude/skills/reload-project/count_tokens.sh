#!/usr/bin/env bash
#
# UTF-8テキストファイルの概算トークン数を標準出力に出す。
#
# 使い方:
#   ./count_tokens.sh <ファイル>
#
# 概算方法:
#   ASCII文字は 4文字 = 1トークン、非ASCII文字 (日本語など) は 1文字 = 1トークン
#   として計算する。UTF-8では日本語1文字が3バイトなので、
#   (バイト数 - 文字数) / 2 で非ASCII文字数を求めている。

set -euo pipefail

if (( $# < 1 )); then
  printf '使い方: count_tokens.sh <ファイル>\n' >&2
  exit 1
fi

file="$1"

if [[ ! -f "$file" ]]; then
  printf 'error: ファイルが見つかりません: %s\n' "$file" >&2
  exit 1
fi

bytes="$(wc -c < "$file")"
chars="$(LC_ALL=en_US.UTF-8 wc -m < "$file")"

non_ascii=$(( (bytes - chars) / 2 ))
ascii=$(( chars - non_ascii ))

if (( ascii < 0 )); then
  ascii=0
fi

printf '%d\n' "$(( ascii / 4 + non_ascii ))"
