"""既存の xlsx にシートを足す / シート名を変える。

    python edit_sheets.py <xlsx> [--out <出力先>] [--env 開発環境] \
        --rename "確認手順_管理画面=確認手順_管理画面" \
        --add    "確認手順_利用者画面=確認手順@after:確認手順_管理画面" \
        --like   "確認エビデンス_利用者画面=確認エビデンス_管理画面@rows:3@after:確認エビデンス_管理画面"

`--out` を省くと元のファイルを書き換える (`.bak` を残す)。

* `--rename 旧名=新名` — `<sheet name=>` と、全シートの `location=` / `tooltip=` に
  埋まっている内部リンクの参照先も書き換える (壊れたリンクはクリックするまで気づけない)
* `--add 新名=種類[@after:基準シート]` — 雛形 (`release-procedure-template.xlsx`) の
  「プログラムの変更箇所」「確認手順」「確認エビデンス」から起こす。`{PART}` はシート名の
  `_` 以降、`{ENV}` は `--env` (既定 `開発環境`) で置換する
* `--like 新名=元シート@rows:N[@after:基準シート]` — **既存シートの列幅と先頭 N 行だけ**を
  写して中身が空のシートを作る。雛形の体裁が実物と揃っていないとき (確認エビデンスは
  雛形が 1 列 1 行しか持たない) はこちらを使う。結合・リンク・画像は引き継がない
* `@after:` を省いた新規シートは末尾に足す

**openpyxl は使わない。** zip のパートを 1 つずつ生コピーし、`xl/workbook.xml` /
`xl/_rels/workbook.xml.rels` / `[Content_Types].xml` だけ書き直す (17MB の画像パートに触らない)。

**既存の `sheetN.xml` の番号と `rId` は動かさない。** `xl/worksheets/_rels/sheetN.xml.rels` が
画像をパート名で束ねているため。新規は空き番号の最大 + 1 を取る。
**並び順は `<sheet>` 要素の順で決まる**のでパート番号と一致しなくてよい。

**`xl/styles.xml` と `docProps/app.xml` は触らない。** 雛形の `s=` はすべて実物にもあり、
`TitlesOfParts` がシート数と食い違っても Excel で開けることは実測済み。
"""
import os, re, sys, zipfile

TPL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "release-procedure-template.xlsx")
NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument"
KIND = {"プログラムの変更箇所": 2, "確認手順": 3, "確認エビデンス": 4}


def attrs(tag):
    return dict(re.findall(r'([\w:]+)="([^"]*)"', tag))


def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def parse_argv(argv):
    xlsx, out, env, ops = None, None, "開発環境", []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--rename", "--add", "--like"):
            i += 1
            if "=" not in argv[i]:
                sys.exit("%s は 名前=値 の形で渡す: %s" % (a, argv[i]))
            ops.append((a[2:],) + tuple(argv[i].split("=", 1)))
        elif a == "--out":
            i += 1
            out = argv[i]
        elif a == "--env":
            i += 1
            env = argv[i]
        elif a.startswith("--"):
            sys.exit("不明なオプション: %s" % a)
        elif xlsx is None:
            xlsx = a
        else:
            sys.exit("引数が多い: %s" % a)
        i += 1
    if not xlsx or not ops:
        sys.exit(__doc__)
    return xlsx, out, env, ops


def split_opts(spec):
    """"元シート@rows:3@after:X" -> ("元シート", {"rows": "3", "after": "X"})"""
    head, opt = spec, {}
    while "@" in head:
        head, _, kv = head.rpartition("@")
        k, _, v = kv.partition(":")
        if k not in ("rows", "after"):
            sys.exit("不明な @オプション: %s" % k)
        opt[k] = v
    return head, opt


def like_sheet(src, rows):
    """既存シートの列幅と先頭 rows 行だけを写した空シートを作る"""
    if "<sheetData>" not in src:
        sys.exit("--like の元シートに sheetData が無い")
    head = src[:src.index("<sheetData>")]
    body = src[src.index("<sheetData>") + len("<sheetData>"):src.index("</sheetData>")]
    keep = "".join(m.group(0) for m in
                   re.finditer(r"(?s)<row [^>]*?(?:/>|>.*?</row>)", body)
                   if int(re.match(r'<row [^>]*\br="(\d+)"', m.group(0)).group(1)) <= rows)
    last = re.search(r'<dimension ref="A1:([A-Z]+)\d+" />', head)
    head = re.sub(r'<dimension ref="A1:[A-Z]+\d+" />',
                  '<dimension ref="A1:%s%d" />' % (last.group(1) if last else "A", rows), head)
    margins = re.search(r"<pageMargins [^>]*/>", src)
    return head + "<sheetData>" + keep + "</sheetData>" + \
        (margins.group(0) if margins else "") + "</worksheet>"


def main():
    xlsx, out, env, ops = parse_argv(sys.argv[1:])
    zin = zipfile.ZipFile(xlsx)
    raw = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    infos = zin.infolist()
    text = {n: raw[n].decode() for n in raw
            if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")}

    wb = raw["xl/workbook.xml"].decode()
    sheets = [attrs(t) for t in re.findall(r"<sheet [^>]*/>", wb)]
    rels = raw["xl/_rels/workbook.xml.rels"].decode()
    rid2part = {a["Id"]: a["Target"].lstrip("/") for a in
                (attrs(t) for t in re.findall(r"<Relationship [^>]*/>", rels))
                if a["Type"].endswith("/worksheet")}
    next_part = max(int(re.search(r"sheet(\d+)\.xml", p).group(1)) for p in rid2part.values()) + 1
    next_rid = max(int(a["Id"][3:]) for a in
                   (attrs(t) for t in re.findall(r"<Relationship [^>]*/>", rels))) + 1
    next_id = max(int(s["sheetId"]) for s in sheets) + 1

    tpl = None
    added, log = [], []

    for op in ops:
        kind, name, spec = op[0], op[1], op[2]
        if kind == "rename":
            old, new = name, spec
            hit = [s for s in sheets if s["name"] == old]
            if not hit:
                sys.exit("シートが無い: %s" % old)
            if any(s["name"] == new for s in sheets):
                sys.exit("同じ名前のシートがある: %s" % new)
            hit[0]["name"] = new
            for n, s in text.items():           # 内部リンクの参照先を追随させる
                text[n] = re.sub(
                    r'(location|tooltip)="([^"]*)"',
                    lambda m: '%s="%s"' % (m.group(1), m.group(2).replace(old, new)), s)
            log.append("改名  %s -> %s" % (old, new))
            continue

        src, opt = split_opts(spec)
        if any(s["name"] == name for s in sheets):
            sys.exit("同じ名前のシートがある: %s" % name)
        if kind == "add":
            if src not in KIND:
                sys.exit("種類は %s のいずれか: %s" % ("/".join(KIND), src))
            if tpl is None:
                with zipfile.ZipFile(TPL) as zt:
                    tpl = {n: zt.read(n).decode() for n in zt.namelist()}
            part = name.partition("_")[2]
            body = tpl["xl/worksheets/sheet%d.xml" % KIND[src]]
            body = body.replace("{PART}での", part + "での" if part else "").replace("{PART}", part)
            body = body.replace("{ENV}", env)
            note = "雛形の %s" % src
        else:
            hit = [i for i, s in enumerate(sheets) if s["name"] == src]
            if not hit:
                sys.exit("--like の元シートが無い: %s" % src)
            if "rows" not in opt:
                sys.exit("--like には @rows:N (写す見出し行数) が必要")
            body = like_sheet(text[rid2part[sheets[hit[0]]["r:id"]]], int(opt["rows"]))
            note = "%s の列幅 + 先頭 %s 行" % (src, opt["rows"])

        path = "xl/worksheets/sheet%d.xml" % next_part
        text[path] = body
        entry = {"name": name, "sheetId": str(next_id), "state": "visible", "r:id": "rId%d" % next_rid}
        if "after" in opt:
            at = [i for i, s in enumerate(sheets) if s["name"] == opt["after"]]
            if not at:
                sys.exit("@after のシートが無い: %s" % opt["after"])
            sheets.insert(at[0] + 1, entry)
        else:
            sheets.append(entry)
        added.append((path, "rId%d" % next_rid))
        log.append("追加  %s (%s) -> %s" % (name, note, path))
        next_part, next_rid, next_id = next_part + 1, next_rid + 1, next_id + 1

    wb = re.sub(r"<sheets>.*?</sheets>",
                "<sheets>%s</sheets>" % "".join(
                    '<sheet name="%s" sheetId="%s" state="%s" r:id="%s" />'
                    % (s["name"], s["sheetId"], s.get("state", "visible"), s["r:id"]) for s in sheets),
                wb, flags=re.S)
    rels = rels.replace("</Relationships>", "".join(
        '<Relationship Type="%s/worksheet" Target="/%s" Id="%s" />' % (NS, p, r)
        for p, r in added) + "</Relationships>")
    ct = raw["[Content_Types].xml"].decode().replace(
        '<Override PartName="/xl/workbook.xml"', "".join(
            '<Override PartName="/%s" ContentType="%s.spreadsheetml.worksheet+xml" />' % (p, CT)
            for p, _ in added) + '<Override PartName="/xl/workbook.xml"')

    raw["xl/workbook.xml"] = wb.encode()
    raw["xl/_rels/workbook.xml.rels"] = rels.encode()
    raw["[Content_Types].xml"] = ct.encode()
    for n, s in text.items():
        raw[n] = s.encode()

    dst = out or xlsx
    if not out:
        os.replace(xlsx, xlsx + ".bak")
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for i in infos:                          # 元の並びと圧縮方式を保つ
            z.writestr(i, raw[i.filename])
        for p, _ in added:
            z.writestr(p, raw[p])

    rid2part.update({r: p for p, r in added})
    print("%s (%d シート)" % (dst, len(sheets)))
    for line in log:
        print("  " + line)
    for i, s in enumerate(sheets):
        print("  %d %-40s %s -> %s" % (i, s["name"], s["r:id"], rid2part[s["r:id"]]))


if __name__ == "__main__":
    main()
