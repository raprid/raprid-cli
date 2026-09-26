"""撮った生フレームから**拡張機能の「Claude is active」表示だけ**を消す。

    python dechrome.py <画像...> [--out <dir>] [--check-only] [--measure]
                       [--top N] [--bottom N] [--left N] [--right N]

■ 何を消すのか
Claude in Chrome が操作しているタブには、拡張機能側が目印を描く。
**ページの DOM には無く** (`document.body` の子は 3 つだけ、shadow root も無い)、
`javascript_tool` からは触れない。**ブラウザが窓の上に直接描いている。**
そのため次のどれでも消えない (2026-01-15 に全部試した):

  * `computer {action:"left_click"}` で × を押す → 合成イベントはページに届くだけ
  * Chrome を非フォーカスにして撮る / 9 秒待つ → そのまま残る
  * **ページを再読み込みする / タブを切り替えて戻す** → そのまま残る
  * **タブを閉じて同じ URL を新しいタブで開く** → そのまま残る (ターゲット単位の設定ではない)

`screencapture` は窓の見た目をそのまま撮るので、**撮影後に画素で消すしかない。**

■ 見た目は一定ではない。必ず `--measure` で測ってから塗る
同じ拡張機能なのに、セッションによって描き方が違う。実測した 2 例:

  (A) 2026-01-15 昼 — 橙のグローとピル
      ビューポート四辺に橙が染み出す (上 54 / 左 54 / 右 54 / 下 121px, 2x) のと、
      下端中央の「Claude is active in this tab group」のピル (下から 44〜104px, 2x)。
      → `--top 54 --left 54 --right 54 --bottom 150` (既定値はこれ)
  (B) 2026-01-15 夕 — マゼンタ / シアンの細枠
      ウェブ内容領域の**上端・下端にマゼンタ rgb(255,0,255)、左端にシアン
      rgb(0,255,255) が各 8px (2x = 論理 4px)**。右端には出ない。
      → `--top 8 --bottom 8 --left 8 --right 0`

**既定値を当てる前に `--measure` を見ること。** (B) に (A) の既定値を当てると、
下端 150px を塗り潰して**詳細画面の固定フッター (58 論理 px = 116px) が消える。**

■ 消し方 —— 切り落とさずに「縁の内側の色で塗り替える」
切り落とすと寸法が変わり、ほかのエビデンスと表示倍率がずれる。
管理画面は**縁から 64px (2x) 内側までが無地の余白**なので (ロゴの緑バッジは列 64 から、
表は論理 x=33 から)、**縁の内側 1 行/1 列の色をそのまま外へ伸ばす**と元の余白が復元できる。
これで**寸法は元のまま**保たれる。

下端は無地とは限らないので、**塗り替える帯にページの内容が無いことを確かめてから**塗る。
確かめるのはピルの左右 (列 70-1120 と 1930-2960) で、行ごとに色幅が 12 を超えたら
**内容が隠れている**と見なして止める。そのときはスクロール位置を変えて撮り直す。
"""
import os
import sys
import numpy as np
from PIL import Image

RIM = 54          # 上・左・右の既定 (2x px)。例 (A) の橙グローの染み出し
BOT = 150         # 下端の既定 (2x px)。例 (A) のピル + グロー
FLAT = 12         # 「無地」と見なす行内の色幅 (チャンネルごと)。下端のグローだけで 9 出る
SIDE = (70, 1120, 1930, 2960)    # 下端の検査に使う列域。ピル (1150-1875) と側面のグローを外す
MEASURE_N = 60    # --measure で内側を見る幅 (2x px)


def measure(a, name):
    """四辺から内側へ、色みのある (無彩色でない) 行・列がどこまで続くかを出す。

    塗る幅を目分量で決めないための下ごしらえ。中央値の R/G/B の開き (chroma) と、
    その辺の基準となる内側の行/列との平均差を並べて出す。
    """
    H, W, _ = a.shape
    print(f'--- {name} {W}x{H} ---')
    for label, get in (
        ('上', lambda i: a[i]),
        ('下', lambda i: a[H - 1 - i]),
        ('左', lambda i: a[:, i]),
        ('右', lambda i: a[:, W - 1 - i]),
    ):
        rows = []
        for i in range(MEASURE_N):
            med = np.median(get(i), axis=0)
            rows.append((i, med, int(med.max() - med.min())))
        chroma = [i for i, _, c in rows if c > 20]
        run = 0
        while run < MEASURE_N and rows[run][2] > 20:
            run += 1
        head = ' '.join(f'{i}:{tuple(int(v) for v in m)}' for i, m, _ in rows[:6])
        print(f'  {label}辺 色みのある行/列 {chroma[:12]}  端から連続 {run}px  先頭 {head}')


args = sys.argv[1:]
out_dir, check_only, do_measure, paths = None, False, False, []
top, bot, left, right = RIM, BOT, RIM, RIM
while args:
    a = args.pop(0)
    if a == '--out':
        out_dir = args.pop(0)
    elif a == '--check-only':
        check_only = True
    elif a == '--measure':
        do_measure = True
    elif a == '--top':
        top = int(args.pop(0))
    elif a == '--bottom':
        bot = int(args.pop(0))
    elif a == '--left':
        left = int(args.pop(0))
    elif a == '--right':
        right = int(args.pop(0))
    else:
        paths.append(a)
if not paths:
    sys.exit(__doc__)
if out_dir:
    os.makedirs(out_dir, exist_ok=True)

ng = 0
for p in paths:
    a = np.asarray(Image.open(p).convert('RGB'), dtype=np.int16).copy()
    H, W, _ = a.shape
    name = os.path.basename(p)

    if do_measure:
        measure(a, name)
        continue

    # 下端: 塗り替える帯に内容が無いか。ピルの左右だけ見る (ピル自体は当然内容がある)
    if bot:
        band = np.concatenate([a[H - bot:, SIDE[0]:SIDE[1]], a[H - bot:, SIDE[2]:SIDE[3]]], axis=1)
        # 色幅は**チャンネルごと**に測る。R と B をまたいで測るとグローの橙みを内容と誤認する
        spread = (band.max(axis=1) - band.min(axis=1)).max(axis=1)
        bad = int((spread > FLAT).sum())
        if bad:
            print(f'NG {name}  下端 {bot}px のうち {bad} 行に内容がある。'
                  f'スクロール位置を変えて撮り直す')
            ng += 1
            continue
        print(f'OK {name}  {W}x{H}  下端 {bot}px は無地')
    else:
        print(f'OK {name}  {W}x{H}  下端は塗らない')
    if check_only:
        continue

    if bot:
        a[H - bot:] = a[H - bot - 1]                  # 下 → 内側の 1 行で塗り替え
    if top:
        a[:top] = a[top]                              # 上
    if left:
        a[:, :left] = a[:, left:left + 1]             # 左 (上下を直した後なので角も無地になる)
    if right:
        a[:, W - right:] = a[:, W - right - 1:W - right]   # 右
    dst = os.path.join(out_dir, name) if out_dir else p
    Image.fromarray(a.astype(np.uint8)).save(dst)

sys.exit(1 if ng else 0)
