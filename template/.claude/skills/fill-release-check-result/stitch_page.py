"""スクロールしながら撮った複数枚を1枚の全ページ PNG に合成する。

使い方:
    stitch.py 出力.png --top T --bot B [--search S]  frame0.png 0  frame1.png d1 ...

  --top / --bot  固定ヘッダ・固定フッタの高さ(論理px)。DOM の実測値を渡す。
  --search       継ぎ目の探索幅(論理px、既定 45)。
                 行が等間隔に並ぶ一覧では、行高より小さくして誤マッチを防ぐ。
  --exact 1      探索せず指定量をそのまま継ぎ目にする。scrollTop に数値を代入して
                 撮った場合はスクロール量が厳密に分かっているので、こちらが正しい。
                 (探索は JPEG のノイズや空白域で数 px 誤マッチすることがある)
  d1, d2 ...     直前フレームからのスクロール量(論理px)。概算でよい。
                 実際の継ぎ目は直前フレーム下端の帯を次フレーム内で探して決める。

出力には「指定位置での平均差」も出るので、実測が指定と食い違ったときは
どちらの位置が本当に一致しているのかを数値で確かめられる。
"""
import sys
import numpy as np
from PIL import Image

EXACT = 0         # 1 なら継ぎ目を探索しない
SCALE = 2         # 既定は Retina 2x。--scale 1 で MCP のタブ描画 (1x) にも使える
BAND_L = 60       # 照合に使う帯の高さ(論理px)
SEARCH_L = 45     # 期待位置からの探索幅(論理px)
XSTEP = 4         # 横方向のサンプリング間隔
RIGHT_CROP_L = 40  # 右端はスクロールバーが動くので照合から除く(論理px)
WARN = 8.0        # 平均差がこれを超えたら照合失敗を疑う
SAME = 1.0        # 隣のフレームとの平均差がこれ未満なら「同じ絵」= 撮影が凍結

args = sys.argv[1:]
out = args.pop(0)
top_l = bot_l = None
while args and args[0].startswith('--'):
    k = args.pop(0); v = int(args.pop(0))
    if k == '--scale':
        SCALE = v
        continue
    if k == '--exact':
        EXACT = v
        continue
    if k == '--top': top_l = v
    elif k == '--bot': bot_l = v
    elif k == '--search': SEARCH_L = v
    else: sys.exit(f'不明なオプション {k}')
if top_l is None or bot_l is None:
    sys.exit('--top と --bot は必須 (DOM から実測して渡す)')

paths = args[0::2]
hints = [int(d) for d in args[1::2]]
imgs = [np.asarray(Image.open(p).convert('RGB'), dtype=np.int16) for p in paths]
H, W = imgs[0].shape[:2]
for p, im in zip(paths, imgs):
    if im.shape[:2] != (H, W):
        sys.exit(f'{p} のサイズが1枚目と違う')

# 隣り合うフレームが同一なら、スクロールが画面に届いていない
# (2026-01-15: Chrome のウィンドウのサーフェスが凍結し、DOM は動いているのに
#  画面は CDP アタッチ前の 1 枚を出し続けた。タブ帯の文字も変わらず、
#  Page.captureScreenshot はタイムアウトし、visibilityState は hidden のままだった。
#  凍結中の screencapture はエラーにならないので、ここで気付けるようにしておく)
for i in range(1, len(imgs)):
    if float(np.abs(imgs[i] - imgs[i - 1]).mean()) < SAME:
        sys.exit(f'NG {paths[i]} が {paths[i - 1]} と同一。スクロールが画面に反映されて'
                 f'いない (Chrome の描画が凍結している疑い)。Chrome を再起動して撮り直す')

top, bot = top_l * SCALE, bot_l * SCALE
V = H - top - bot
low = top + V                    # 可視領域の下端
band, search = BAND_L * SCALE, SEARCH_L * SCALE
xs = slice(0, W - RIGHT_CROP_L * SCALE, XSTEP)
print(f'固定ヘッダ {top_l}px / 固定フッタ {bot_l}px / スクロール可視高 {V // SCALE}px'
      f' / 探索幅 ±{SEARCH_L}px')

parts = [imgs[0][0:low]]         # 固定ヘッダ + 1枚目の可視部すべて
prev, total_scroll, ng = imgs[0], 0, 0
for i in range(1, len(imgs)):
    img = imgs[i]
    tmpl = prev[low - band:low, xs]
    p0 = low - hints[i] * SCALE - band
    lo, hi = max(0, p0 - search), min(low - band, p0 + search)
    cand = [(float(np.abs(img[p:p + band, xs] - tmpl).mean()), p) for p in range(lo, hi + 1)]
    cand.sort()
    d, p = cand[0]
    if EXACT:
        p = p0
        d = float(np.abs(img[p:p + band, xs] - tmpl).mean())
    actual = (low - band - p) / SCALE
    # 指定位置そのままの平均差も出して、誤マッチかどうかを比べられるようにする
    d_hint = next((c for c, q in cand if q == p0), None)
    hint_note = '' if d_hint is None else f'  (指定位置の平均差 {d_hint:.1f})'
    mark = ''
    if d > WARN:
        mark = f'  ★照合が甘い(平均差 {d:.1f}) 手動で確認'
        ng += 1
    elif actual != hints[i] and d_hint is not None and d_hint - d < 1.0:
        mark = '  ★指定位置とほぼ同じ一致度。行の繰り返しによる誤マッチを疑う'
        ng += 1
    print(f'  {i}枚目: 指定 {hints[i]}px → 実測 {actual:g}px  平均差 {d:.1f}{hint_note}{mark}')
    parts.append(img[p + band:low])
    total_scroll += actual
    prev = img
parts.append(imgs[0][H - bot:H])  # 固定フッタ

canvas = np.concatenate(parts, axis=0).astype(np.uint8)
Image.fromarray(canvas).save(out)
exp = top + V + int(total_scroll * SCALE) + bot
print(f'{out}  {W}x{canvas.shape[0]}  (期待 {W}x{exp})  論理 {W // SCALE}x{canvas.shape[0] // SCALE}')
if ng:
    print(f'※ {ng} 箇所で照合が怪しい。--search を行高より小さくするか、合成結果を目視で確かめること')
