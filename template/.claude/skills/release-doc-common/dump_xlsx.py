"""xlsx のシート構成・列幅・非空セル・画像アンカー・スタイルをテキストで吐く (検証用)。

    python dump_xlsx.py <xlsx>                # 全シート
    python dump_xlsx.py <xlsx> <シート名>      # 1 シートだけ
    python dump_xlsx.py <xlsx> --styles       # styles.xml の cellXfs を列挙する

行頭のラベル (`sheet` / `列幅` / `セル` / `画像` / `行高`) で grep して
別のファイルと突き合わせられるようにしてある。

**スタイル番号とアンカーは openpyxl を経由せず zip の生 XML から読む。**
openpyxl は `s=` を持ち回らないし、`<col>` / `<row>` の属性の並び順も Excel と違う。
"""
import re, sys, zipfile
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


def attrs(tag):
    return dict(re.findall(r'(\w+)="([^"]*)"', tag))


def sheet_paths(path):
    """シート名 -> xl/worksheets/sheetN.xml を workbook.xml と rels で解決する。"""
    z = zipfile.ZipFile(path)
    rid = {attrs(r)["Id"]: attrs(r)["Target"].lstrip("/")
           for r in re.findall(r"<Relationship [^>]*/>", z.read("xl/_rels/workbook.xml.rels").decode())}
    out = {}
    for s in re.findall(r"<sheet [^>]*/>", z.read("xl/workbook.xml").decode()):
        a = attrs(s)
        t = rid[a["r:id"] if "r:id" in a else a["id"]]
        out[a["name"]] = t if t.startswith("xl/") else "xl/" + t
    return z, out


def dump_styles(path):
    xml = zipfile.ZipFile(path).read("xl/styles.xml").decode()
    for label in ("fonts", "fills", "borders", "cellStyleXfs", "cellXfs"):
        m = re.search(r"<%s count=\"(\d+)\"" % label, xml)
        print("%s: %s" % (label, m.group(1) if m else "-"))
    body = re.search(r"<cellXfs .*?>(.*)</cellXfs>", xml, re.S).group(1)
    for i, xf in enumerate(re.findall(r"<xf\b.*?(?:/>|</xf>)", body, re.S)):
        print("s=%d %s" % (i, xf))


def main():
    path = sys.argv[1]
    if "--styles" in sys.argv:
        return dump_styles(path)
    only = sys.argv[2] if len(sys.argv) > 2 else None

    z, paths = sheet_paths(path)
    wb = load_workbook(path)
    print("sheets: %s" % wb.sheetnames)
    for ws in wb.worksheets:
        if only and ws.title != only:
            continue
        xml = z.read(paths[ws.title]).decode()
        print("\nsheet: %s  dims=%s  images=%d  part=%s"
              % (ws.title, ws.dimensions, len(ws._images), paths[ws.title]))

        cols = [attrs(c) for c in re.findall(r"<col [^>]*/>", xml)]
        print("列幅: %s" % " ".join(
            "%s=%s" % (get_column_letter(int(c["min"])), round(float(c["width"]), 1)) for c in cols))

        # 値の無いセル (`<c r="F5" s="5" t="n" />`) は**自己終了**で来る。`/>` を先に見ないと
        # 次のセルの `</c>` まで飲み込み、**隣のセルの値をこのセルの値として表示してしまう**
        for m in re.finditer(r'<c r="([A-Z]+\d+)"([^>]*?)(?:/>|>(.*?)</c>)', xml, re.S):
            ref, at, body = m.group(1), attrs(m.group(2)), m.group(3) or ''
            t = re.search(r"<t[^>]*>(.*?)</t>", body, re.S)
            if t and t.group(1).strip():
                print("セル: %-6s s=%-2s %s" % (ref, at.get("s", "0"),
                                                t.group(1).replace("\n", "\\n")[:300]))

        for im in ws._images:
            a = im.anchor
            f, to, ext = a._from, getattr(a, "to", None), getattr(a, "ext", None)
            # oneCellAnchor は <ext> の実寸で貼る形 (歪まない)。twoCellAnchor は行高依存
            print("画像: @%s%d%s%s size=%dx%d %s%s" % (
                get_column_letter(f.col + 1), f.row + 1,
                "+%dEMU" % f.rowOff if f.rowOff else "",
                (" .. %s%d" % (get_column_letter(to.col + 1), to.row + 1)) if to else "",
                im.width, im.height,
                "twoCellAnchor editAs=%s" % getattr(a, "editAs", "-") if to else "oneCellAnchor",
                " ext=%dx%d" % (ext.cx, ext.cy) if ext else " ★ext無し"))

        for r in re.findall(r"<row [^>]*>", xml):
            a = attrs(r)
            if "ht" in a:
                print("行高: %s=%s" % (a["r"], a["ht"]))

        merges = re.findall(r'<mergeCell ref="([^"]+)"', xml)
        if merges:
            print("結合: %d 個 %s" % (len(merges), " ".join(sorted(merges)[:8])))


if __name__ == "__main__":
    main()
