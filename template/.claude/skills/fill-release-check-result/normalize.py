"""撮った生フレームを**表示幅は変えずに画素密度だけ上げた 1 枚**に揃える。

    python normalize.py <画像...> [--width 2016] [--pad 191] [--out <dir>]
                        [--src-width N] [--allow-upscale] [--dry-run]

■ なぜ要るのか — 「ぶれている」の原因は解像度の不一致だった

変更箇所シートの画像は **1426px を 713px 幅で表示** している (2 倍)。
確認エビデンスシートは **1512px を 1512px 幅で表示** していた (1 倍)。
Retina でスプレッドシートを開くと描画側が 2 倍に引き伸ばすので、
**1 倍で貼った画像だけが甘くなる。** 縮小もドライブの 2048px 上限も効いていない
(実測: エビデンス 35 枚はすべて長辺 2048px 以下、hover の帯も無し)。

そこで **2 倍 (3024px) で撮って 2016px に落とし、表示は 1512px のまま置く**。

    3024 ──(× 2/3)──> 2016 ──(表示 1512px)──> 実効 1.33 倍

* `2016 = 3024 × 2/3` で**割り切れる**ので、リサンプルの位相が全画素で揃う
* `2016 <= 2048` なので**ドライブの長辺上限に掛からない** (掛かると幅から崩れる)
* 2 倍のまま (3024px) 貼れないのはこの上限のため。2/3 はその制約下の最大値

■ 高さの上限が CSS 換算で下がることに注意

長辺 2048px の上限は幅にも効くので、**幅 2016px なら高さも 2048px までしか使えない**。
`2048 × 1512 / 2016 = 1536` — つまり **CSS で 1536px より高いページは分割が要る。**
1 倍のときは 2048 CSS px まで入っていたので、**分割の要否は撮り直しで変わる**。
判定は normalize のあとに `release-doc-common/split_tall.py` でやること
(先に分割すると切り位置が最終画素とずれる)。

■ 幅を揃える

`verify_floating.py` は表示幅が全枚で揃っていることを見る。撮影中にウィンドウ幅が
変わると生フレームの幅がばらつくので、**狭いものを右にページ地色で継ぎ足してから**
落とす。地色は既定 `rgb(191,191,191)` (管理画面の本文外の地色)。
**引き伸ばして揃えることは絶対にしない** —— それは直そうとしているボケそのもの。

■ 拡大は拒む

元が `--width` より狭いときは既定でエラーにする。1 倍で撮った古いフレームを
そのまま 2016px に拡大しても情報は増えず、ボケが増えるだけ。
撮り直しが正しい対処なので `--allow-upscale` は検証用にだけ置いてある。
"""
import io, os, sys
import numpy as np
from PIL import Image

try:
    import oxipng
except ImportError:
    oxipng = None

WIDTH = 2016     # 出力の画素幅 (3024 の 2/3)
CAP = 2048       # Google ドライブが長辺を縮め始める境界
PAD = 191        # 管理画面の本文外の地色 (無彩色なので 1 値で持つ)


def parse(argv):
    files, o = [], dict(width=WIDTH, pad=PAD, out=None, src=None,
                        upscale=False, dry=False)
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--width':
            o['width'] = int(argv[i + 1]); i += 2
        elif a == '--pad':
            o['pad'] = int(argv[i + 1]); i += 2
        elif a == '--out':
            o['out'] = argv[i + 1]; i += 2
        elif a == '--src-width':
            o['src'] = int(argv[i + 1]); i += 2
        elif a == '--allow-upscale':
            o['upscale'] = True; i += 1
        elif a == '--dry-run':
            o['dry'] = True; i += 1
        elif a.startswith('--'):
            sys.exit(f'知らない引数: {a}')
        else:
            files.append(a); i += 1
    if not files:
        sys.exit(__doc__)
    return files, o


files, o = parse(sys.argv[1:])
sizes = {}
for f in files:
    with Image.open(f) as im:
        sizes[f] = im.size

src = o['src'] or max(w for w, _ in sizes.values())
wide = [(f, sizes[f][0]) for f in files if sizes[f][0] > src]
if wide:
    sys.exit('元が --src-width より広い (切り落とすことになるので止める): '
             + ', '.join(f'{os.path.basename(f)} {w}px' for f, w in wide))
if src < o['width'] and not o['upscale']:
    sys.exit(f'元の幅 {src}px が出力幅 {o["width"]}px より狭い。'
             '拡大してもボケが増えるだけなので 2 倍で撮り直す '
             '(検証目的なら --allow-upscale)')

ratio = o['width'] / src
exact = '' if (3 * o['width']) % 2 == 0 and src * 2 == o['width'] * 3 \
    else '  ★2/3 になっていない (位相が揃わないので甘くなる)'
print(f'元 {src}px -> 出力 {o["width"]}px  (x {ratio:.4f}){exact}')
print(f'高さの上限: {CAP}px  = 元換算 {round(CAP / ratio)}px\n')

padded = tall = 0
for f in files:
    w, h = sizes[f]
    with Image.open(f) as im:
        im = im.convert('RGB')
        if w < src:                      # 右に地色を継ぎ足して幅を合わせる
            canvas = Image.new('RGB', (src, h), (o['pad'],) * 3)
            canvas.paste(im, (0, 0))
            im = canvas
            padded += 1
        nh = round(h * ratio)
        out = im.resize((o['width'], nh), Image.LANCZOS)

    dst = f if o['out'] is None else os.path.join(o['out'], os.path.basename(f))
    flag = ''
    if nh > CAP:
        flag = f'  ★高さ {nh} > {CAP} — split_tall.py で {-(-nh // CAP)} 枚に割る'
        tall += 1
    print(f'  {os.path.basename(f):<44} {w}x{h} -> {o["width"]}x{nh}'
          f'{"  (右を " + str(src - w) + "px 継ぎ足し)" if w < src else ""}{flag}')
    if o['dry']:
        continue
    if o['out']:
        os.makedirs(o['out'], exist_ok=True)
    buf = io.BytesIO()
    out.save(buf, 'PNG')
    data = buf.getvalue()
    if oxipng:
        try:
            data = oxipng.optimize_from_memory(data, level=4)
        except Exception:
            pass
    with open(dst, 'wb') as fp:
        fp.write(data)

print(f'\n{len(files)} 枚 / 幅を継ぎ足し {padded} 枚 / 分割が要る {tall} 枚'
      + ('  (--dry-run なので書いていない)' if o['dry'] else ''))
if tall:
    print(f'次: release-doc-common/split_tall.py <画像...> --max {CAP} '
          '--check /tmp/cuts.png  (切り位置は目で見る)')
