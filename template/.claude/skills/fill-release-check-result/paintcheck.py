"""paintprobe.js で置いた目印が写っているかを確かめる。

    paintcheck.py 画像.png --rect x y w h --rgb r g b [--scale 2]

引数の x y w h と r g b は paintprobe.js の戻り値をそのまま渡す (論理 px / 0-255)。
写っていなければ、その画像は**いまの画面ではない**ので撮り直す。
凍結の直し方と背景は paintprobe.js の冒頭を読む。
"""
import sys
import numpy as np
from PIL import Image

TOL = 6.0   # 目印の平均色とのずれの許容値。同一なら 1 未満


def main(argv):
    path = argv[0]
    rect = rgb = None
    scale = 2
    for i, a in enumerate(argv):
        if a == '--rect':
            rect = [int(v) for v in argv[i + 1:i + 5]]
        elif a == '--rgb':
            rgb = [int(v) for v in argv[i + 1:i + 4]]
        elif a == '--scale':
            scale = int(argv[i + 1])
    if not rect or not rgb:
        sys.exit(__doc__)

    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    x, y, w, h = (v * scale for v in rect)
    # 端の 1/4 は角丸やサブピクセルの影響を受けるので内側だけ見る
    m = min(w, h) // 4
    win = a[y + m:y + h - m, x + m:x + w - m]
    if win.size == 0:
        sys.exit(f'NG {path}: 目印の位置 {rect} が画像 {a.shape[1]}x{a.shape[0]} の外')
    got = win.reshape(-1, 3).mean(axis=0)
    d = float(np.abs(got - np.array(rgb, dtype=np.float32)).mean())
    if d > TOL:
        sys.exit(f'NG {path}: 目印が写っていない (期待 rgb{tuple(rgb)} / 実測 '
                 f'rgb{tuple(int(v) for v in got)} 平均差 {d:.1f})。'
                 f'画面が凍結して古いフレームを撮っている疑い。paintprobe.js の冒頭を読む')
    print(f'OK {path} 目印 rgb{tuple(rgb)} を確認 (平均差 {d:.1f}) = いまの画面')


if __name__ == '__main__':
    main(sys.argv[1:])
