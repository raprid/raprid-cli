"""撮った PNG が「狙ったタブの、狙った矩形」で「無地」かを機械的に確かめる。

  shotcheck.py 画像.png                                サイズと非空白だけ見る (基準を作るとき)
  shotcheck.py 画像.png --ref 基準.png --head 225      固定ヘッダー帯を比べる
  shotcheck.py 画像.png --nohover                      hover の焼き付きを探す
  shotcheck.py 画像.png --nohover --table-top 300      表が始まる y (論理 px) より下だけを見る
  shotcheck.py 画像.png --nohover --hover-rgb 244      hover の色が違うアプリで使う

■ ヘッダー帯の照合 (--ref)
screencapture は画面に映っているものを撮るだけなので、ウィンドウ・タブ・座標の
どれかを間違えると無関係な画面がそのままエビデンスとして残る。2026-01-15 に
(1) 別ウィンドウ (2) 同じウィンドウの別タブ (3) 反映前の bounds を読んで 56px
ずれる、の 3 通りを踏んだ。判定は固定ヘッダー帯が基準と一致するかで行う。
この帯は position: fixed なのでスクロールしても動かず、別のウィンドウ・タブを
撮った場合だけ一致しなくなる。

■ hover の焼き付き (--nohover)
表の行に `:hover` が残ったまま撮ると、その行が全幅の淡いグレーの帯になる。
判定は **幅と色の両方**で行う。片方だけでは区別できないものが 3 つある:

  * **入力欄の地色は hover と同じ rgb(247,247,247)。** 色だけでは分けられないので
    全幅 (>=85%) を占める帯に限る。入力欄は幅が足りないので落ちる
  * **表のヘッダー行は全幅の帯になる** (実測 rgb(234,233,233))。幅だけでは分けられない
    ので、色が hover の実測値に一致するものに限る
  * **モーダルの覆いも全幅** (実測 rgb(141,142,141))。同じく色で落ちる

hover の色はアプリの CSS 次第なので `--hover-rgb` で変えられる。
撮る前の予防は precapture.js。ここはその取りこぼしを捕まえる最後の関門。
"""
import sys
import numpy as np
from PIL import Image

SCALE = 2
TOL = 6.0        # ヘッダー帯の平均絶対差の許容値。同一内容なら 1 未満、別画面なら数十
COVER = 0.85     # 走査線のうちこの割合以上が同色なら「全幅の帯」
MIN_RUN = 12     # これより薄い帯は罫線・境界線なので無視 (論理 px 換算で 6px)
WHITE = 250      # これ以上明るい単色は白地として扱う
FLAT = 6         # R/G/B の開きがこれ以内なら無彩色 = 地色の候補
HOVER_RGB = 247  # hover の行ハイライトの実測色 (--hover-rgb で変える)
HOVER_TOL = 2


def full_width_bands(a, y_from=0):
    """全幅を占める非白の無彩色の帯を返す。[(y0, y1, (r,g,b))]"""
    h, w, _ = a.shape
    hit = [None] * h
    for y in range(y_from, h):
        row = a[y].reshape(-1, 3)
        cols, cnt = np.unique(row, axis=0, return_counts=True)
        i = int(cnt.argmax())
        c, n = cols[i], int(cnt[i])
        if n / w >= COVER and int(c.min()) < WHITE and int(c.max()) - int(c.min()) <= FLAT:
            hit[y] = tuple(int(v) for v in c)
    runs, y = [], y_from
    while y < h:
        if hit[y] is not None:
            y0, col = y, hit[y]
            while y < h and hit[y] == col:
                y += 1
            if y - y0 >= MIN_RUN:
                runs.append((y0, y - 1, col))
        else:
            y += 1
    return runs


def main(argv):
    path = argv[0]
    ref = head = None
    nohover = False
    table_top = 0
    hover_rgb = HOVER_RGB
    for i, a in enumerate(argv):
        if a == '--ref':
            ref = argv[i + 1]
        elif a == '--head':
            head = int(argv[i + 1])
        elif a == '--nohover':
            nohover = True
        elif a == '--table-top':
            table_top = int(argv[i + 1])
        elif a == '--hover-rgb':
            hover_rgb = int(argv[i + 1])

    img = Image.open(path).convert('RGB')
    a = np.asarray(img, dtype=np.float32)
    if a.shape[0] < 100 or a.shape[1] < 100:
        sys.exit(f'NG {path}: 画像が小さすぎる {a.shape[1]}x{a.shape[0]}')
    if a.std() < 3.0:
        sys.exit(f'NG {path}: ほぼ一色で中身が無い (std {a.std():.2f})')

    notes = []

    if ref:
        b = np.asarray(Image.open(ref).convert('RGB'), dtype=np.float32)
        if a.shape != b.shape:
            sys.exit(f'NG {path}: 基準と寸法が違う '
                     f'{a.shape[1]}x{a.shape[0]} vs {b.shape[1]}x{b.shape[0]}')
        h = head * SCALE if head else min(225 * SCALE, a.shape[0])
        d = float(np.abs(a[:h] - b[:h]).mean())
        if d > TOL:
            sys.exit(f'NG {path}: 固定ヘッダー帯が基準と一致しない (平均差 {d:.2f} > {TOL})。'
                     f'撮影対象のウィンドウ・タブ・矩形のいずれかがずれている')
        notes.append(f'ヘッダー平均差 {d:.2f}')

    if nohover:
        # 画像が 2x なら論理 px の指定を倍にする
        scale = 2 if a.shape[1] >= 2000 else 1
        runs = full_width_bands(np.asarray(img), y_from=table_top * scale)
        # 色が hover の実測値に一致するものだけを残す
        # (表のヘッダー行 234 / モーダルの覆い 141 は正当なのでここで落ちる)
        runs = [r for r in runs if abs(r[2][0] - hover_rgb) <= HOVER_TOL]
        if runs:
            d = ', '.join(f'y={y0}-{y1} rgb{c}' for y0, y1, c in runs[:4])
            sys.exit(f'NG {path}: hover の焼き付きらしい全幅の帯がある ({d})。'
                     f'precapture.js の ok が true になってから撮り直す')
        notes.append(f'hover (rgb{(hover_rgb,)*3}) の帯なし')

    print(f'OK {path} {a.shape[1]}x{a.shape[0]}'
          + (f' {" / ".join(notes)}' if notes else f' std {a.std():.1f}'))


if __name__ == '__main__':
    main(sys.argv[1:])
