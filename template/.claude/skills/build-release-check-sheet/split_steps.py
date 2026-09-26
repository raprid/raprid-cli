"""確認手順シートを「1 行 = 1 手順」で書き出す。

    python split_steps.py <xlsx> "確認手順_管理画面=rows_admin.txt" "確認手順_運用画面=rows_operator.txt"

rows ファイルは 1 行 1 手順の `No.|画面|確認手順|期待値` (セル内改行は `\\n` エスケープ)。

**zip の中で該当シートの XML を 1 パートだけ差し替える。** 確認手順シートは全セルが
`t="inlineStr"` で `sharedStrings.xml` に依存しないのでこれが成立し、
変更箇所シート・エビデンスシートの画像には一切触らない。
openpyxl で開いて保存し直しても `oneCellAnchor` のアンカーは落ちないが、
17MB の画像を読み書きし直すぶん遅く、壊れたときの影響が資料全体に及ぶ。

細部:
* **`ht` / `customHeight` を付けない。** 付けると 18pt に固定され、C / D 列の折り返しが
  見切れる。属性が無ければ Excel が `wrapText` に応じて高さを自動で合わせる
* **No. は `t="inlineStr"`。** 数値にすると `1.10` が `1.1` に丸められる
* 1〜3 行目 (A1 の案内文・空行・ヘッダー) はそのまま残す
* **`<hyperlinks>` は落とす。** 結果セルからエビデンスへのリンクは行番号を持つので、
  行を差し替えると存在しない行を指す。張り直しは `fill_results.py` の仕事

書式 (styles.xml の cellXfs):
  s=2 A1 / s=3 ヘッダー / s=4 C3 / s=5 A・E・F・G (折り返し無し) / s=6 B・C・D (wrapText)
"""
import os, re, shutil, sys, zipfile

FIELDS = 4          # No. / 画面 / 確認手順 / 期待値
FIRST_ROW = 4       # 1〜3 行目はヘッダー


def attrs(tag):
    return dict(re.findall(r'(\w+)="([^"]*)"', tag))


def sheet_paths(z):
    """シート名 -> xl/worksheets/sheetN.xml。番号の決め打ちをしないための解決。"""
    rid = {attrs(r)["Id"]: attrs(r)["Target"].lstrip("/")
           for r in re.findall(r"<Relationship [^>]*/>",
                               z.read("xl/_rels/workbook.xml.rels").decode())}
    out = {}
    for s in re.findall(r"<sheet [^>]*/>", z.read("xl/workbook.xml").decode()):
        a = attrs(s)
        t = rid[a.get("r:id") or a["id"]]
        out[a["name"]] = t if t.startswith("xl/") else "xl/" + t
    return out


def esc(s):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.replace("\n", "&#10;")


def build_rows(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(l.rstrip("\n") for l in f if l.strip()):
            f4 = line.split("|")
            if len(f4) != FIELDS:
                sys.exit("%s の %d 行目が %d フィールド (期待 %d): %s"
                         % (path, i + 1, len(f4), FIELDS, line[:80]))
            r = FIRST_ROW + i
            cells = ['<c r="%s%d" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                     % (col, r, style, esc(v.replace("\\n", "\n")))
                     for col, v, style in zip("ABCD", f4, (5, 6, 6, 6))]
            # 結果・確認者・確認日は実施者が後から埋める
            cells += ['<c r="%s%d" s="5" t="n" />' % (col, r) for col in "EFG"]
            out.append('<row r="%d">%s</row>' % (r, "".join(cells)))
    return out


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    xlsx, plan = sys.argv[1], []
    for a in sys.argv[2:]:
        if "=" not in a:
            sys.exit("引数は <シート名>=<rows ファイル> の形で渡す: %s" % a)
        title, path = a.split("=", 1)
        plan.append((title, path))

    bak = xlsx + ".bak"
    shutil.copy(xlsx, bak)
    zin = zipfile.ZipFile(bak)
    paths = sheet_paths(zin)

    patched = {}
    for title, rows_path in plan:
        if title not in paths:
            sys.exit("シートが見つからない: %s (%s)" % (title, ", ".join(paths)))
        name = paths[title]
        xml = zin.read(name).decode("utf-8")
        start = xml.index("<sheetData>")
        head, tail = xml[:start + len("<sheetData>")], xml[xml.index("</sheetData>"):]
        keep = re.match(r'(?s).*?(<row r="3".*?</row>)', xml[start:]).group(0)[len("<sheetData>"):]
        # 行を差し替えると既存の結果セルのリンクは行番号ごと合わなくなるので落とす
        # (fill_results.py が張り直す。残すと存在しない行を指す壊れたリンクになる)
        tail = re.sub(r"<hyperlinks>.*?</hyperlinks>", "", tail, flags=re.S)
        rows = build_rows(rows_path)
        last = FIRST_ROW - 1 + len(rows)
        head = re.sub(r'<dimension ref="A1:G\d+" />', '<dimension ref="A1:G%d" />' % last, head)
        patched[name] = head + keep + "".join(rows) + tail
        print("%-34s %-26s %d 行 (%d〜%d)" % (title, name, len(rows), FIRST_ROW, last))

    with zipfile.ZipFile(xlsx, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = patched.get(item.filename)
            zout.writestr(item, data.encode("utf-8") if data else zin.read(item.filename))
    zin.close()
    print("saved: %s (%d bytes) / 元は %s" % (xlsx, os.path.getsize(xlsx), bak))


if __name__ == "__main__":
    main()
