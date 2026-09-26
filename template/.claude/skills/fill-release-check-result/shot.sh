#!/bin/sh
# 画面に映っている Chrome のタブを 1 枚撮り、基準フレームの位置で切り出す。
#
# 使い方:
#   SHOT_PY=<venv の python> SHOT_REF=<基準.png> [SHOT_MATCH=<URL部分文字列>] \
#     shot.sh 出力先.png
#
#   SHOT_PY     openpyxl / Pillow / numpy が入った python (必須)
#   SHOT_REF    位置合わせに使う基準フレーム (必須。目で見て確かめた 1 枚)
#   SHOT_MATCH  撮影したいタブの URL 部分文字列 (既定 localhost)
#   SHOT_URL    撮影したいタブの URL 完全一致 (指定すると SHOT_MATCH より優先)
#   SHOT_TMP    作業用ディレクトリ (既定 ${TMPDIR:-/tmp})
#
# ■ 撮る前に必ずブラウザ側の下ごしらえを済ませること
# このスクリプトは「画面に映っているもの」を撮るだけで、ページの状態には触れない。
# **`:hover` の行ハイライトとテキストキャレットは、撮る前にブラウザ側で消す。**
# 手順は precapture.js と SKILL.md の「3. 撮る前にページを無地にする」。
#
# ■ screencapture はポインタを写さない
# `-C` を付けない限り矢印は写らない (2026-01-15 に同一矩形を -C 有/無で撮って差分 0)。
# エビデンスに写る「カーソル」はポインタではなく **`:hover` の行ハイライト**である。
# しかも `:hover` は **OS のカーソル位置ではなく、レンダラに最後に届いた
# マウスイベントの座標**で決まるので、warp.py でカーソルを退避しても剥がれない。
# 下の warp は Dock と OS のツールチップを避けるためだけのもの。
#
# ■ 部分一致は前方一致で別タブに当たる
# 一覧 /admin/items と詳細 /admin/items/<id> のように URL が前方一致する
# タブが同じウィンドウに並ぶと、部分一致では**先に見つかった方**を前面に出してしまう
# (2026-01-15 に一覧を撮ろうとして詳細タブを前面化した)。そのときは URL を
# 丸ごと SHOT_URL に渡して完全一致で選ぶ。

# ■ 座標指定をやめている理由
# ウィンドウは撮影の合間に動く。2026-01-15 に踏んだ事故は 4 通り:
#   (1) 別ウィンドウを撮った  (2) 同じウィンドウの別タブを撮った
#   (3) 前面化の直後に bounds を読んで反映前の座標を得た
#   (4) f0 と f1 の間でウィンドウが 56 論理 px 動いた
# そのため画面全体を撮ってから、基準フレームの固定ヘッダー帯を相関で探して
# その位置で切り出す (locate.py)。
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
MATCH=${SHOT_MATCH:-localhost}
TMP=${SHOT_TMP:-${TMPDIR:-/tmp}}
[ -n "$SHOT_PY" ] || { echo "SHOT_PY に venv の python を指定する" >&2; exit 1; }
[ -n "$SHOT_REF" ] || { echo "SHOT_REF に基準フレームを指定する" >&2; exit 1; }
[ -n "$1" ] || { echo "出力先の png を指定する" >&2; exit 1; }

# 1. URL でタブを探し、そのタブをアクティブにしてウィンドウを前面へ
if [ -n "$SHOT_URL" ]; then
  COND="(URL of tab j of window i) is \"$SHOT_URL\""
  MATCH=$SHOT_URL
else
  COND="(URL of tab j of window i) contains \"$MATCH\""
fi
osascript <<APPLESCRIPT >/dev/null
tell application "Google Chrome"
  set wHit to 0
  set tHit to 0
  repeat with i from 1 to (count of windows)
    repeat with j from 1 to (count of tabs of window i)
      if $COND then
        set wHit to i
        set tHit to j
        exit repeat
      end if
    end repeat
    if wHit is not 0 then exit repeat
  end repeat
  if wHit = 0 then error "撮影対象のタブが見つからない: $MATCH"
  set active tab index of window wHit to tHit
  set index of window wHit to 1
  activate
end tell
APPLESCRIPT
# 前面化の反映を待つ。foreground の sleep は使えないので osascript で待つ
osascript -e 'delay 0.6' >/dev/null

# 2. カーソルを画面右端へ退避 (Dock と OS のツールチップを写さない)
"$SHOT_PY" "$DIR/warp.py" 1505 300

# 3. 画面全体を撮り、基準フレームと一致する位置で切り出す
screencapture -T 1 -x -D 1 "$TMP/_full.png"
"$SHOT_PY" "$DIR/locate.py" "$TMP/_full.png" "$SHOT_REF" "$1"
