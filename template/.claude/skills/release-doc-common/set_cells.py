"""既存の xlsx のセルに文字列を書く / 既存の文字列の末尾に足す。

    python set_cells.py <xlsx> <tsv> [--append] [--out <出力先>]

TSV は 1 行 1 セルで `シート名 \t セル \t 値`。`#` で始まる行と空行は読み飛ばす。
値の中の `\n` (2 文字) は改行に展開する (TSV に生の改行は書けない)。

* 既定は**置き換え**。`--append` を付けると既存の文字列の末尾に足す
  (元の末尾の空白と改行は落としてから、改行 1 つを挟んで繋ぐ)
* `--out` を省くと元のファイルを書き換える

**書式 (`s=`) は動かさない。** 各スクリプトが `s=` の番号を決め打ちしているため、
番号が動くと資料全体の書式が総崩れになる。

**セルは `t="inlineStr"` で書く。** `sharedStrings.xml` に足すと
「該当パートだけ差し替える」前提が崩れる (10MB の画像パートに触りたくない)。
元が `t="s"` (sharedStrings 参照) のセルも inlineStr に変える。**参照が減るだけで
`sharedStrings.xml` は触らない** —— `count` 属性は実際の参照数と食い違っても
Excel が読み直すときに再計算する (2026-01-15 に実測)。

用途の例。**Excel で手編集すると `3.1` のような No. が数値になり**、ほかの行
(文字列) と配置が揃わないうえ `<t>` を読む道具から見えなくなる。これを直す:

    printf '確認手順_管理画面\tA9\t3.1\n' | ... > /tmp/no.tsv
    python set_cells.py out.xlsx /tmp/no.tsv

C 列の末尾にシナリオ ID を足す (`verify_steps.py` の集合一致が読む形):

    確認手順_管理画面	C4	シナリオ: (A-1-1) (A-1-2)
"""
import io, os, re, shutil, sys, zipfile
from xml.sax.saxutils import escape


def attrs(tag):
    return dict(re.findall(r'([\w:]+)="([^"]*)"', tag))


def sheet_parts(z):
    """シート名 -> パート名"""
    rid = {}
    for r in re.findall(r"<Relationship\b[^>]*/?>", z.read("xl/_rels/workbook.xml.rels").decode()):
        a = attrs(r)
        t = a["Target"].lstrip("/")
        rid[a["Id"]] = t if t.startswith("xl/") else "xl/" + t
    out = {}
    # **属性の並び順に依存しない。** Excel が保存すると `<sheet state="visible" name=...>` と
    # state が先に来るため、name を先頭に固定した正規表現では 1 枚も拾えない。
    for s in re.findall(r"<sheet\b[^>]*/?>", z.read("xl/workbook.xml").decode()):
        a = attrs(s)
        if "name" in a:
            out[a["name"]] = rid[a.get("r:id") or a["id"]]
    return out


def shared(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    xml = z.read("xl/sharedStrings.xml").decode()
    return [re.sub(r"<[^>]+>", "", m.group(1))
            for m in re.finditer(r"<si>(.*?)</si>", xml, re.S)]


def main():
    argv, append, out = [], False, None
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--append":
            append = True
        elif a == "--out":
            out = next(it)
        elif a.startswith("--"):
            sys.exit("不明なオプション: %s" % a)
        else:
            argv.append(a)
    if len(argv) != 2:
        sys.exit(__doc__)
    xlsx, tsv = argv
    out = out or xlsx

    z = zipfile.ZipFile(xlsx)
    parts, sst = sheet_parts(z), shared(z)
    new, n = {}, 0

    for ln, line in enumerate(io.open(tsv, encoding="utf-8"), 1):
        line = line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        f = line.split("\t")
        if len(f) != 3:
            sys.exit("%s:%d 列が %d 個 (シート名/セル/値 の 3 つ): %r" % (tsv, ln, len(f), line))
        title, ref, val = f
        val = val.replace("\\n", "\n")
        if title not in parts:
            sys.exit("シートが無い: %s (%s)" % (title, ", ".join(parts)))
        part = parts[title]
        xml = new.get(part) or z.read(part).decode()

        pat = re.compile(r'<c\b[^>]*\br="%s"(?:\s[^>]*)?(?:/>|>.*?</c>)' % ref, re.S)
        m = pat.search(xml)
        if not m:
            sys.exit("%s!%s のセルが無い" % (title, ref))
        a = attrs(m.group(0))
        if append:
            if a.get("t") == "s":
                cur = sst[int(re.search(r"<v>(\d+)</v>", m.group(0)).group(1))]
            else:
                cur = "".join(re.findall(r"<t[^>]*>(.*?)</t>", m.group(0), re.S))
                cur = re.sub(r"&lt;", "<", re.sub(r"&gt;", ">", re.sub(r"&amp;", "&", cur)))
            val = cur.rstrip() + "\n" + val
        cell = ('<c r="%s" s="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                % (ref, a.get("s", "0"), escape(val)))
        new[part] = xml[:m.start()] + cell + xml[m.end():]
        n += 1
        print("%s!%s  %s  <- %r" % (title, ref, "追記" if append else "置換",
                                    val[-60:] if append else val[:60]))

    z.close()
    tmp = out + ".tmp"
    with zipfile.ZipFile(xlsx) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for it2 in zin.infolist():
            b = new.get(it2.filename)
            zout.writestr(it2, b.encode() if b is not None else zin.read(it2.filename))
    shutil.move(tmp, out)
    print("\n%s に %d セル書いた (差し替えたのは %s だけ)" % (out, n, "・".join(sorted(new))))


if __name__ == "__main__":
    main()
