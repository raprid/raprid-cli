"""貼り付けた画像の検証。

    python verify_floating.py <xlsx>

  * **すべて `oneCellAnchor` + 明示 `<ext>` か** (`twoCellAnchor` は行高に引きずられて歪む)
  * `<ext>` の縦横比が画像の実寸と一致しているか (= どこで開いても歪まないか)
  * 画像が土台 (結合セル) の中に収まっているか (= ラベル行に被らないか)
  * **土台の行がすべて 18.0pt か** (端数行があると行高を丸める描画系で土台が縮む)
  * 画像同士が重なっていないか / 縦の間隔は揃っているか
  * 横幅がすべて同じか
  * 土台の中に文字セルが紛れていないか
  * **画像の長辺が 2048px 以下か** (Google ドライブ上での画質はここで決まる)

**幅は「表示幅 (EMU)」と「画素幅」の 2 つを別に見ている。** 揃っているか調べるのは
表示幅で、2048px の上限に掛かるのは画素の長辺。**この 2 つは同じである必要はない** ——
表示幅 1512px のまま画素を 2016px にすれば、表示は変えずに密度だけ上げられる
(Retina でスプレッドシートが 2 倍に引き伸ばすぶんを先に持たせておく、という意味)。
確認エビデンスがボケていた原因はここが 1:1 だったこと。
"""
import re, sys, zipfile
from PIL import Image

X = sys.argv[1]
z = zipfile.ZipFile(X)

def resolve(base, t):
    if t.startswith("/"):
        return t[1:]
    d = base.rsplit("/", 1)[0]
    while t.startswith("../"):
        t, d = t[3:], d.rsplit("/", 1)[0]
    return f"{d}/{t}" if d else t

def rels(part):
    p = part.rsplit("/", 1)
    rp = f"{p[0]}/_rels/{p[1]}.rels"
    if rp not in z.namelist():
        return {}
    return {re.search(r'Id="([^"]+)"', r).group(1): resolve(part, re.search(r'Target="([^"]+)"', r).group(1))
            for r in re.findall(r"<Relationship[^>]*/>", z.read(rp).decode())}

PT2PX = 4 / 3
EMU = 9525
ROW_PT = 18.0                 # 土台の行高。24px
# Google スプレッドシート (Office 編集モード) は画像データを長辺 2048px に縮小してから
# 配信する。これを超えると幅が崩れて表示枠に引き伸ばされるので、Excel では無傷でも
# Google ドライブ上で文字が潰れる。split_tall.py で分割しておく。
CAP = 2048
ng = 0

wb = z.read("xl/workbook.xml").decode()
wr = rels("xl/workbook.xml")

# **属性の並び順に依存しない。** Excel が保存すると `<sheet state="visible" name=...>` と
# state が先に来るため、name を先頭に固定した正規表現では 1 枚も拾えず、
# **画像が 1 つも検査されないまま「OK」と出る** (2026-01-15 に blank で踏んだ)。
sheets = []
for m in re.finditer(r"<sheet [^>]*/?>", wb):
    at = dict(re.findall(r'(?:\w+:)?(\w+)="([^"]+)"', m.group(0)))
    if "name" in at and "id" in at:
        sheets.append((at["name"], at["id"]))
if not sheets:
    sys.exit("★シートを 1 枚も読めなかった。workbook.xml の形が想定と違う")
for nm, rid in sheets:
    ws = wr[rid]
    drw = next((t for t in rels(ws).values() if "/drawings/" in t), None)
    if not drw:
        continue
    xml = z.read(ws).decode()
    dr = rels(drw)
    dx = z.read(drw).decode()

    # 列幅 (px) と行高 (pt)
    cols = {}
    # openpyxl と Excel で属性の並び順が違うので、1 要素ずつ属性を拾う
    for m in re.finditer(r"<col [^>]*/>", xml):
        at = dict(re.findall(r'(\w+)="([^"]+)"', m.group(0)))
        if "width" not in at:
            continue
        for c in range(int(at["min"]), int(at["max"]) + 1):
            cols[c] = round(float(at["width"]) * 7) + 5
    dflt_w = re.search(r'defaultColWidth="([\d.]+)"', xml)
    dflt_w = round(float(dflt_w.group(1)) * 7) + 5 if dflt_w else 64
    hts = {}
    for m in re.finditer(r"<row [^>]*>", xml):
        at = dict(re.findall(r'(\w+)="([^"]+)"', m.group(0)))
        if "ht" in at:
            hts[int(at["r"])] = float(at["ht"])
    dflt_h = re.search(r'defaultRowHeight="([\d.]+)"', xml)
    dflt_h = float(dflt_h.group(1)) if dflt_h else 15.0

    def x_of(col):   # 1 始まりの col の左端 px
        return sum(cols.get(c, dflt_w) for c in range(1, col))
    def y_of(row):   # 1 始まりの row の上端 px
        return sum(hts.get(r, dflt_h) for r in range(1, row)) * PT2PX

    def cnum(s):
        n = 0
        for ch in s:
            n = n * 26 + ord(ch) - 64
        return n

    merges = [(cnum(m.group(1)), int(m.group(2)), cnum(m.group(3)), int(m.group(4)))
              for m in re.finditer(r'<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"', xml)]

    # 文字が入っているセル (行 -> 列)
    # **空セルは `<c r="A6" s="0" t="n" />` と自己終了タグで書き出されることがある。**
    # `</c>` を終端に使うと、このセルでガードが効かずに下の行の `<v>` まで走って
    # 空セルを「文字あり」と誤判定する (2026-01-15 に土台 10 個で偽陽性が出た)。
    # セルの範囲を先に切り出し、その中だけを見る。
    text_rows = {}
    cell = re.compile(r'<c r="([A-Z]+)(\d+)"[^>]*?(/>|>(?:(?!</c>).)*?</c>)', re.S)
    for m in cell.finditer(xml):
        if re.search(r'<(?:v|is)[ >]', m.group(3)):
            text_rows.setdefault(int(m.group(2)), []).append(m.group(1))

    two = len(re.findall(r"<(?:xdr:)?twoCellAnchor", dx))
    rects = []
    for m in re.finditer(r"<(?:xdr:)?oneCellAnchor[^>]*>.*?</(?:xdr:)?oneCellAnchor>", dx, re.S):
        s = m.group(0)
        f = re.search(r"<(?:xdr:)?from>\s*<(?:xdr:)?col>(\d+)</(?:xdr:)?col>\s*"
                      r"<(?:xdr:)?colOff>(-?\d+)</(?:xdr:)?colOff>\s*"
                      r"<(?:xdr:)?row>(\d+)</(?:xdr:)?row>\s*"
                      r"<(?:xdr:)?rowOff>(-?\d+)</(?:xdr:)?rowOff>", s, re.S)
        e = re.search(r'<(?:xdr:)?ext cx="(\d+)" cy="(\d+)"', s)
        emb = re.search(r'r:embed="([^"]+)"', s)
        c0, r0 = int(f.group(1)) + 1, int(f.group(3)) + 1     # 1 始まりに直す
        colOff, rowOff = int(f.group(2)), int(f.group(4))
        img = dr[emb.group(1)]
        with Image.open(zipfile.ZipFile(X).open(img)) as im:
            iw, ih = im.size
        rects.append(dict(r0=r0, c0=c0, img=img, iw=iw, ih=ih, ext=e,
                          cx=int(e.group(1)) if e else 0, cy=int(e.group(2)) if e else 0,
                          x0=x_of(c0) + colOff / EMU, y0=y_of(r0) + rowOff / EMU))

    rects.sort(key=lambda d: (d["y0"], d["r0"]))
    print(f"\n=== {nm} — 画像 {len(rects)} 枚"
          + (f"   ★twoCellAnchor {two} 個 (行高で歪む)" if two else ""))
    if two:
        ng += two
    prev_y, prev_base = None, None
    widths, bases = set(), set()
    for d in rects:
        if not d["ext"]:
            print(f"  {d['r0']:>4} ★<ext> が無い ({d['img']})"); ng += 1; continue
        w, h = d["cx"] / EMU, d["cy"] / EMU
        y1 = d["y0"] + h
        widths.add(round(w, 2))

        # 縦横比: <ext> が画像の実寸と一致しているか
        dev = d["cy"] - d["cx"] * d["ih"] / d["iw"]
        # 土台 (from セルを含む同じ左端の結合セル)
        mg = next(((a, b, c, e) for a, b, c, e in merges
                   if a == d["c0"] and b <= d["r0"] <= e), None)
        if not mg:
            print(f"  {d['r0']:>4} ★土台 (結合セル) が無い ({d['img']})"); ng += 1; continue
        _, R0, C1, R1 = mg
        bt, bb = y_of(R0), y_of(R1 + 1)
        bases.add((R0, R1))
        frac = [r for r in range(R0, R1 + 1) if abs(hts.get(r, dflt_h) - ROW_PT) > 1e-9]
        intr = [r for r in range(R0, R1 + 1) if r in text_rows]
        if prev_base is None:
            gap = "        "
        elif (R0, R1) == prev_base:
            gap = "継ぎ    "                       # 同じ土台の 2 枚目以降
        else:
            gap = f"間隔 {R0 - prev_base[1] - 1:>2} 行"   # 前の土台の下端から空けた行数
        flag = ""
        if abs(dev) > 1:
            flag += f" ★比ずれ {dev:+.0f}EMU"; ng += 1
        if d["y0"] < bt - 0.01 or y1 > bb + 0.01:
            flag += f" ★土台外 画像 {d['y0']:.1f}〜{y1:.1f} / 土台 {bt:.1f}〜{bb:.1f}"; ng += 1
        if frac:
            flag += f" ★端数行 {[(r, hts.get(r)) for r in frac[:3]]}"; ng += 1
        if intr:
            flag += f" ★文字セル {intr}"; ng += 1
        if prev_y is not None and d["y0"] < prev_y - 0.01:
            flag += " ★重なり"; ng += 1
        if max(d["iw"], d["ih"]) > CAP:
            flag += (f" ★長辺 {max(d['iw'], d['ih'])}px > {CAP} "
                     f"(Google ドライブで劣化)"); ng += 1
        print(f"  {d['r0']:>4}     {w:>4.0f}x{h:<7.1f} 画像 {d['iw']}x{d['ih']} "
              f"比{dev:+3.0f}EMU 土台 {R0}:{R1} 余白{bb - y1:>6.1f}px {gap}{flag}"
              f"  {d['img'].split('/')[-1]}")
        prev_y, prev_base = y1, (R0, R1)
    print(f"  横幅: {sorted(widths)}  -> {'統一' if len(widths) == 1 else '★不揃い'}")
    if len(widths) > 1:
        ng += 1
    print(f"  土台 {len(bases)} 個 / 画像 {len(rects)} 枚"
          + ("  (1 土台に複数枚 = 分割画像の継ぎ)" if len(bases) < len(rects) else ""))
    over = [max(d["iw"], d["ih"]) for d in rects if max(d["iw"], d["ih"]) > CAP]
    print(f"  長辺 {CAP}px 超: {len(over)} 枚"
          + (f"  -> ★{sorted(over, reverse=True)}" if over else "  (Google ドライブ上でも劣化しない)"))

print(f"\n判定: {'OK' if ng == 0 else f'NG {ng} 件'}")
