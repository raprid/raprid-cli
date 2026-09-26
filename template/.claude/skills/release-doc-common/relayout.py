"""「プログラムの変更箇所」シートの**器** (結合・ラベル・列幅・行高) を作る。

    python relayout.py <in.xlsx> <out(shell).xlsx> <manifest.tsv> \
        [--width 713] [--gap 2] [--lastcol 12] [--start "<シート名>=13"]

manifest.tsv は 1 行 1 枚のタブ区切り `シート名 ⇥ 順番 ⇥ ラベル ⇥ 画像パス`。
同じシートの行は書いた順に上から並ぶ (順番の列は目視と検証のためのもので、
1 から始まる連番であることだけを見る)。

**ラベルが空の行は「継ぎ」**で、直前の画像の真下に、ラベル行も空行も挟まずに置く
(split_tall.py で 1 ファイルを複数枚に割ったとき。見た目は 1 枚に繋がる)。
1 行目のラベルを空にはできない。

## 土台 (画像を置く結合セル)

ラベルのある 1 枚 + それに続く継ぎを**1 つの鎖**とし、鎖ごとに

    「ファイル名の行 (游ゴシック 20pt 太字)」+「A〜L を結合した土台」

の 1 組を作る。**土台は 18.0pt (24px) の行だけで組み、鎖の合計高さを行単位で切り上げる。**
端数を最終行の行高で吸収すると 0.38pt のような行ができ、行高を丸める描画系
(Google スプレッドシート等) で土台が縮んで画像がラベル行にはみ出す。
切り上げておけば土台は必ず画像以上の高さになる。

画像そのものは place_images.py が `oneCellAnchor` + 実寸 `<ext>` で貼るので、
**土台の高さが多少余っても画像は伸縮しない** (縦横比は画像の実寸から決まる)。

土台の左上にはプレースホルダを置き、`<out>.plan`
(シート / 土台のアドレス / 画像パス / 高さ px / 幅 px) を書き出す。
**実際に画像を貼るのは place_images.py。**

開始行は既定で「そのシートの最終非空行 + 2」(説明文の 1 行下にラベル、その下に画像)。
説明文を先に書いてから実行すること。`--start` で上書きできる。

**貼り直しにも使える。** 前回の A〜L の結合が残っているシートでは、その先頭行の 1 つ上を
開始行に取り、それ以降のセルを白紙に戻してから組み直す
(前回のラベル行が新しい矩形の中に取り残されるのを防ぐ)。
"""
import collections, io, math, os, sys
from openpyxl import load_workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from PIL import Image as PILImage

ROW_PX, ROW_PT = 24, 18.0     # 土台の 1 行。18pt = 24px
LABEL_PT = 28.5               # ファイル名の行 (20pt)


def col_px(total, lastcol, first=67):
    """A〜<lastcol> の合計が total px ちょうどになる内訳。px = round(width*7)+5"""
    base, extra = divmod(total - first, lastcol - 1)
    return [first] + [base + 1] * extra + [base] * (lastcol - 1 - extra)


def parse_argv(argv):
    pos, opt = [], {"width": 713, "gap": 2, "lastcol": 12, "start": {}}
    it = iter(argv)
    for a in it:
        if a == "--start":
            t, v = next(it).split("=", 1)
            opt["start"][t] = int(v)
        elif a.startswith("--"):
            opt[a[2:]] = int(next(it))
        else:
            pos.append(a)
    return pos, opt


def read_manifest(path):
    out = collections.OrderedDict()
    for i, line in enumerate(l.rstrip("\n") for l in io.open(path, encoding="utf-8") if l.strip()):
        f = line.split("\t")
        if len(f) != 4:
            sys.exit("%s の %d 行目が %d フィールド (期待 4): %s" % (path, i + 1, len(f), line[:80]))
        title, order, label, img = f
        out.setdefault(title, []).append((int(order), label, img))
    for title, items in out.items():
        got = [o for o, _, _ in items]
        if got != list(range(1, len(got) + 1)):
            sys.exit("%s の順番が 1 からの連番でない: %s" % (title, got))
        if not items[0][1]:
            sys.exit("%s の 1 行目のラベルが空 (継ぎには受け手が要る)" % title)
        for _, _, img in items:
            if not os.path.exists(img):
                sys.exit("画像が無い: %s" % img)
    return out


def last_used_row(ws):
    return max((c.row for row in ws.iter_rows() for c in row
                if c.value is not None and str(c.value).strip()), default=0)


def main():
    pos, opt = parse_argv(sys.argv[1:])
    if len(pos) != 3:
        sys.exit(__doc__)
    src, dst, manifest = pos
    lastcol, gap, width_px = opt["lastcol"], opt["gap"], opt["width"]
    px = col_px(width_px, lastcol)
    assert sum(px) == width_px, (sum(px), width_px)

    wb = load_workbook(src)
    plan_out = []
    for title, items in read_manifest(manifest).items():
        if title not in wb.sheetnames:
            sys.exit("シートが見つからない: %s (%s)" % (title, ", ".join(wb.sheetnames)))
        ws = wb[title]
        ws._images = []
        # 前回の貼付を探す (A〜lastcol を結合した矩形の先頭)。あればその 1 つ上が開始行
        prev = min((r.min_row for r in ws.merged_cells.ranges
                    if r.min_col == 1 and r.max_col == lastcol), default=None)
        for rng in list(ws.merged_cells.ranges):
            ws.unmerge_cells(str(rng))
        for i, p in enumerate(px):
            ws.column_dimensions[get_column_letter(i + 1)].width = (p - 5) / 7

        start = opt["start"].get(title) or (prev - 1 if prev else last_used_row(ws) + 2)
        if prev:                       # 前回のラベル行を残すと矩形の中に文字セルが紛れる
            n_cleared = 0
            for r in range(start, ws.max_row + 1):
                for c in range(1, lastcol + 1):
                    if ws.cell(r, c).value is not None:
                        ws.cell(r, c).value = None
                        n_cleared += 1
            print("  (前回の貼付を A%d 以降で検出: セル %d 個を白紙に戻した)" % (start, n_cleared))
        print("\n=== %s   結合幅 %dpx   開始 A%d" % (title, width_px, start))

        row, label_rows, i = start + 1, [], 0
        while i < len(items):
            j = i + 1                                   # 鎖 = ラベルのある 1 枚 + 続く継ぎ
            while j < len(items) and not items[j][1]:
                j += 1
            chain = items[i:j]

            c = ws.cell(row - 1, 1, chain[0][1])
            c.font = Font(name="游ゴシック", bold=True, size=20)
            label_rows.append(row - 1)
            print("  A%-5d %s" % (row - 1, chain[0][1]))

            pieces, N = [], 0
            for _, _, img in chain:
                with PILImage.open(img) as im:
                    iw, ih = im.size
                h_px = width_px * ih / iw               # 幅を土台に合わせ高さは縦横比から
                pieces.append((img, iw, ih, h_px))
                N += math.ceil(h_px / ROW_PX)           # 土台は行単位で切り上げ

            ws.merge_cells(start_row=row, start_column=1, end_row=row + N - 1, end_column=lastcol)
            ws.cell(row, 1, "__IMG_%d__" % len(plan_out))
            for k, (img, iw, ih, h_px) in enumerate(pieces):
                plan_out.append((title, "A%d" % row, img, round(h_px, 1), width_px))
                print("        %s %dx%d -> %dx%.1fpx" % ("└" if k == 0 else "├ 継ぎ", iw, ih, width_px, h_px))
            total = sum(p[3] for p in pieces)
            print("        土台 A%d:%s%d  %d 行 %dpx (画像計 %.1fpx / 余白 %.1fpx)"
                  % (row, get_column_letter(lastcol), row + N - 1, N, N * ROW_PX, total, N * ROW_PX - total))
            row += N + gap + 1
            i = j

        last = row + 2
        for r in range(1, last + 1):
            ws.row_dimensions[r].height = ROW_PT
        for r in label_rows:
            ws.row_dimensions[r].height = LABEL_PT
        for r in [r for r in ws.row_dimensions if r > last]:
            del ws.row_dimensions[r]
        print("  最終行 %d" % last)

    wb.save(dst)
    io.open(dst + ".plan", "w", encoding="utf-8").write(
        "\n".join("%s\t%s\t%s\t%s\t%s" % t for t in plan_out))
    print("\nsaved: %s  %d bytes  (画像 %d 枚はプレースホルダ / 次は place_images.py)"
          % (dst, os.path.getsize(dst), len(plan_out)))


if __name__ == "__main__":
    main()
