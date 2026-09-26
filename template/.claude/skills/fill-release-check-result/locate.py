"""フルスクリーンの撮影画像から、狙ったタブのビューポートを内容で探して切り出す。

画面座標 (-R) で切ると、ウィンドウが撮影の合間に動いた分だけ静かにずれる。
2026-01-15 に f0 と f1 の間で 56 論理 px 動いていた。そこで座標を信用せず、
基準フレーム (目で見て正しいと確かめた 1 枚) の固定ヘッダー帯を画面内から
相関で探し、その位置からビューポートを切り出す。

固定ヘッダー帯は position: fixed でスクロールしても動かないので、
同じ画面の別スクロール位置でも一致する。別のタブ・別のウィンドウを撮って
しまった場合は一致しないため、平均差で弾ける。

  locate.py 画面全体.png 基準.png 出力.png
"""
import sys
import numpy as np
from PIL import Image

SCALE = 2
BAND_TOP, BAND_BOT = 40, 330     # 基準フレーム内の固定ヘッダー帯 (px)。論理 20-165 を実測で確定
XL, XR = 100, 1400               # 相関に使う列域 (px)
COARSE = 4                      # 粗探索の間引き
TOL = 8.0                       # 平均絶対差の許容値

full_p, ref_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
full = np.asarray(Image.open(full_p).convert('L'), dtype=np.float32)
refc = Image.open(ref_p).convert('RGB')
ref = np.asarray(refc.convert('L'), dtype=np.float32)
VH, VW = ref.shape                      # ビューポート寸法 (px)

band = ref[BAND_TOP:BAND_BOT, XL:XR]
BH = band.shape[0]
if full.shape[1] < VW:
    sys.exit(f'NG: 画面の幅 {full.shape[1]} がビューポート幅 {VW} より狭い')

def diff(dy, dx, step):
    seg = full[dy + BAND_TOP:dy + BAND_TOP + BH:step, dx + XL:dx + XR]
    if seg.shape != band[::step].shape:
        return 1e9
    return float(np.abs(seg - band[::step]).mean())

xs = range(0, full.shape[1] - VW + 1, 8)
ys = range(0, full.shape[0] - VH + 1, COARSE)
cand = sorted((diff(y, x, COARSE), y, x) for y in ys for x in xs)[:12]
best = min((diff(y + ddy, x + ddx, 1), y + ddy, x + ddx)
           for _, y, x in cand
           for ddy in range(-COARSE, COARSE + 1)
           for ddx in range(-8, 9)
           if 0 <= y + ddy <= full.shape[0] - VH and 0 <= x + ddx <= full.shape[1] - VW)
d, dy, dx = best
if d > TOL:
    sys.exit(f'NG {full_p}: 基準の固定ヘッダー帯が画面内に見つからない (最小平均差 {d:.2f} > {TOL})。'
             f'狙ったタブが前面に出ていない')
Image.open(full_p).convert('RGB').crop((dx, dy, dx + VW, dy + VH)).save(out_p)
print(f'OK {out_p} ヘッダー一致 平均差 {d:.2f} / ビューポート原点 px=({dx},{dy}) 論理=({dx / SCALE:.1f},{dy / SCALE:.1f})')
