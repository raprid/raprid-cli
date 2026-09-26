# GitLab の MR 差分を撮る

[SKILL.md](SKILL.md) の手順 4 の詳細。Claude in Chrome での操作例を示す。
Codex では [共通実行ルール](../runtime.md) に従い、利用可能なブラウザの
DOM 評価・スクロール・PNG 撮影へ読み替える。ツール名や待機秒数は環境依存だが、
実スクロール位置の記録と描画確認、全繋ぎ目の画像確認はどの経路でも行う。

diff は仮想スクロール (`vue-virtual-scroller` の `DynamicScroller`) なので DOM を
丸ごと取る手は使えず、1 ファイルは縦に数千 px あるので 1 枚にも収まらない。
**「スクロール位置を指定して撮る」を繰り返してあとで繋ぐ**のが実質唯一の方法。

## 0. 前提

* **タブが前面 (`document.hidden === false`) であること。**
  バックグラウンドタブは Chrome がラスタライズしないので `captureScreenshot` が
  30 秒でタイムアウトする。**JS は通る**ので「ページは生きているのに撮れない」形で出る。
  `osascript` で Chrome を activate しても対象タブが選ばれるとは限らず、
  利用可能なタブ選択機能で前面化し、それができない場合にユーザーへ依頼する
* MR の diffs ページ (`.../merge_requests/<n>/diffs`) を開き、
  **すべてのファイルを展開しておく** (折り畳まれていると高さが取れない)

## 1. 下ごしらえ

トップバー類を消し、diff の文字を拡大する。

```js
// <style id="__shot">
.super-topbar,.super-sidebar-wrapper,.detail-page-header,
.merge-request-sticky-header-wrapper,.panel-header,
.top-scrim-wrapper,.bottom-scrim-wrapper{display:none!important}
.diff-td,.line_content,.diff-line-num,.diff-table,.diff-grid-row,
.diff-content pre,.diff-content code,.line,.diff-file .code{
  font-size:21px!important;line-height:33.6px!important}

// <style id="__shot2">
.mr-version-controls{display:none!important}
.js-file-title{position:static!important}
```

**`document.body.style.zoom` で拡大してはいけない。**
`getBoundingClientRect` は zoom 後、`scrollTop` / `size` は zoom 前という二重単位になり、
仮想スクローラーの可視判定が壊れて先頭 2 ファイルしか描画されなくなる。
**拡大は diff の `font-size` を直接上げる** (GitLab の既定は `0.7875rem` = 12.6px)。

ヘルパーを置く:

```js
window.__sc   = document.querySelector('.vue-recycle-scroller');
window.__ds   = window.__sc.__vue__.$parent;                        // DynamicScroller
window.__pane = document.querySelector('.panel-content-inner.js-static-panel-inner');
window.__up   = () => window.__sc.__vue__.updateVisibleItems(false, true);
```

**本当のスクロール要素は `.panel-content-inner.js-static-panel-inner`** で、
`.vue-recycle-scroller` でも `window` でもない。`pageMode: true` かつ `handleScroll` が
`requestAnimationFrame` 依存なので、**`scrollTop` を変えたら `__up()` を必ず呼ぶ。**

## 2. 高さキャッシュを収束させる

GitLab は各ファイルの高さを**行数 × 行高で事前計算**しているため、CSS を変えても追随しない。
**700px 刻みで全体を 1 往復**させ、各ファイルをアンマウント/再マウントさせると
`__ds.vscrollData.sizes` が実測値に入れ替わる。

* **`items[i].size` に代入しても効かない。** `vscrollData.sizes[id]` が真のソース
  (未定義のキーは `$set` で入れる)
* 手で計算するなら `newSize = oldSize + lines × (新行高 − 20.16)`
* **実際の高さは `size − 16`** (パディング分)

収束したら、表示順に `sizes` の値と行数を読み出す。

## 3. 環境依存の値を実測する

**ウィンドウサイズが変われば全部変わる。** spec JSON の `env` に入れて渡す。

| キー | 意味 | 出しかた | 2026-01-15 の値 |
| --- | --- | --- | --- |
| `k` | スクショ px / CSS px | スクショ幅 ÷ `innerWidth` | `26/27` (1456÷1512) |
| `top` | スクローラーの上端オフセット | pane の上端から scroller まで | `48` |
| `x0` / `x1` | crop の左右 (右は排他) | **スクショの画素を読む** | `8` / `1434` |
| `page` | 1 ページの送り幅 (CSS px) | `top + page <= clientHeight` | `780` (48+780 ≤ 845) |

**`x0` / `x1` を CSS 座標から換算してはいけない。**
`.diff-file` の `getBoundingClientRect().right` に `k` を掛けて PIL の `crop` に渡すと、
**右端が排他なので右枠線が 1px 落ちる。** 左は枠線そのものの座標なので含まれ、
**左だけ枠がある画像**になる。コードの背景が画像の端まで続くため、Excel に貼ると
**「右端で見切れている」と読まれる** (実際に指摘を受けた)。

2026-01-15 の実測 (1512×861 / dpr 2 / スクショ 1456×829 / ダークモード):

```
0..7    サイドバーの残り
8..18   ページ背景 #18171d
19      diff-file の左枠線      ← ここ
20..1421 中身
1422    右枠線                  ← ここ
1423..1447 ページ背景
1448..  スクロールバー
```

枠線の外に背景を 11px ずつ残して `x0,x1 = 8,1434` (幅 1426) とした。

## 4. 撮影計画を作る

```sh
$PY mkspec.py /tmp/spec.json \
  --sizes '[820, 3100, ...]' --names '["api-00-...", ...]' --lines '[24, 118, ...]' \
  --page 780 --k 26/27 --top 48 --x0 8 --x1 1434
```

`--sizes` は `__ds.vscrollData.sizes` を**表示順**に並べたもの。

## 5. 撮る

Chrome 拡張では **1 ページ = 4 アクション**を `browser_batch` で 3〜4 ページずつまとめる。
他の経路では同じ順序で実行し、実際にスクロール先の描画が完了してから撮る。

```json
{"name":"javascript_tool","input":{"action":"javascript_exec","tabId":<TAB>,
  "text":"const p=window.__pane;p.scrollTop=<WANT>;window.__up();'a='+p.scrollTop"}}
{"name":"computer","input":{"action":"wait","duration":5,"tabId":<TAB>}}
{"name":"computer","input":{"action":"wait","duration":2,"tabId":<TAB>}}
{"name":"computer","input":{"action":"screenshot","tabId":<TAB>,"save_to_disk":true}}
```

* **待機の 7 秒を削らない。** 2 秒だと Chrome の合成が追いつかず
  「撮れているが内容が 1 ページ前」という壊れ方をし、しかも**遅延が累積する**
* **待機を JS の `await` で作らない。** CDP の `Runtime.evaluate` が 45 秒でタイムアウトする。
  `computer` の `wait` アクションに出す
* **返ってきた `a=<実 scrollTop>` を全ページ分記録する** (`actual.json`)。
  **最終ページは末尾で clamp される**ので、指定値ではなく読み返した値を `stitch.py` に渡す

撮り終えたら生スクショを撮影順に連番へ:

```sh
i=0
for f in $(ls "$SHOT"/screenshot-*.jpg | sed 's/.*screenshot-//; s/\.jpg//' \
           | awk -F- '{printf "%s-%s\n",$1,$2}' | sort -t- -k1,1n -k2,2n); do
  printf -v n "%02d" $i; cp "$SHOT/screenshot-$f.jpg" "raw/$n.jpg"; i=$((i+1))
done
```

**ファイル名のタイムスタンプは文字列ソートでは順番が狂う。** 数値ソートすること。

## 6. 撮り直しになる条件

* 途中でウィンドウサイズが変わった → `k` から全部やり直し
* 折り畳まれたファイルがあった → 展開して 2 からやり直し
* 繋ぎ目に行番号の欠落があった → **そのファイルだけ撮り直す**

なお**長い行は切れない。** GitLab の diff は折り返すので、`font-size` を上げて
1 行に入る桁数が減っても全文は写る (行数が増えるだけ)。
