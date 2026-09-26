"""確認手順シートを検証する。

    python verify_steps.py <xlsx> "確認手順_管理画面=docs/feature/admin/item-edit" [...] \
        [--skip 00-setup.feature] [--skip 08-regression.feature]

シートごとに `<シート名>=<feature ディレクトリ>[,<ディレクトリ>...]` を渡す。
資料に載せない章は `--skip` にファイル名を並べる (**落とした理由は README に残すこと**)。
**`--skip` はパスでも書ける** (`--skip docs/feature/admin/item-edit/03-save.feature`)。
章番号が同じ別ディレクトリの feature を巻き添えにしたくないときはこちらを使う。

**要はシナリオ ID の集合一致 1 本。** これが通れば行数が変わっても抜けと重複が捕まる。
資料の C 列には `(A-1-1)` の形で ID を残してあり、feature 側は `@A-1-1` のタグ。

**1 つの feature ディレクトリを複数シートで分担するときは `+` でシートを束ねる。**

    python verify_steps.py <xlsx> \
        "確認手順_管理画面+確認手順_利用者画面=docs/feature/admin/item-edit,docs/feature/account/profile"

C 列の ID は束ねた側で合算して比較し、下の機械的な確認は**シートごとに**回す
（1 つの feature 群を管理画面と利用者画面の両方で分担する場合、
シートを分けると片方ずつでは集合一致が通らない）。ID を 1 つも持たない行は素通りする。

あわせて機械的に見るもの:
**A〜D がすべて空の行は素通りする。** Excel が使った範囲の下に書き出す空行
(`<row r="20" ht="15.75" customHeight="1"/>`) は表示に出ないので資料としては無害。

* 行 4 以降で E・F・G (結果・確認者・確認日) が空 — **ヘッダーの 3 行目から見ない**
* 行 4 以降で A〜D が非空
* 行 4 以降に `ht` / `customHeight` が無い (付いていると折り返しが見切れる)
* A 列の No. が `t="inlineStr"` (数値だと `1.10` が `1.1` に丸まる)
* No. の重複が無い
* 他シートの画像と結合が残っている (差し替えで巻き添えにしていないこと)
"""
import glob, os, re, sys, zipfile

ID = r"[A-Z]+-\d+-\d+"
FIRST_ROW = 4


def attrs(tag):
    return dict(re.findall(r'(\w+)="([^"]*)"', tag))


def sheet_paths(z):
    rid = {attrs(r)["Id"]: attrs(r)["Target"].lstrip("/")
           for r in re.findall(r"<Relationship [^>]*/>",
                               z.read("xl/_rels/workbook.xml.rels").decode())}
    out = {}
    for s in re.findall(r"<sheet [^>]*/>", z.read("xl/workbook.xml").decode()):
        a = attrs(s)
        t = rid[a.get("r:id") or a["id"]]
        out[a["name"]] = t if t.startswith("xl/") else "xl/" + t
    return out


def rows_of(xml):
    """行番号 -> {列: (スタイル, 型, 本文)}"""
    out = {}
    for m in re.finditer(r"<row ([^>]*)>(.*?)</row>", xml, re.S):
        a = attrs(m.group(1))
        cells = {}
        for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', m.group(2), re.S):
            ca = attrs(c.group(2))
            t = re.search(r"<t[^>]*>(.*?)</t>", c.group(3) or "", re.S)
            cells[c.group(1)] = (ca.get("s", "0"), ca.get("t", ""), t.group(1) if t else "")
        out[int(a["r"])] = (a, cells)
    return out


def feature_ids(dirs, skip):
    ids, used = set(), []
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, "*.feature"))):
            base = os.path.basename(path)
            # **`--skip` はファイル名でもパスの末尾でも書ける。** ファイル名だけで
            # 突き合わせると、章番号が同じ別ディレクトリの feature まで巻き添えになる
            # (`admin/item-edit/03-save.feature` を外したいのに
            # `account/profile/03-save.feature` も消える)。
            rel = path.replace(os.sep, "/")
            if base.startswith("_") or base in skip \
                    or any(rel == k or rel.endswith("/" + k)
                           for k in (k.strip("/") for k in skip) if "/" in k):
                continue
            # タグは `@A-3-3 @manual` のように 1 行に複数並ぶ。行末までを要求しない
            found = set(re.findall(r"@(%s)\b" % ID, "\n".join(
                l for l in open(path, encoding="utf-8") if l.lstrip().startswith("@"))))
            ids |= found
            used.append((path, len(found)))
    return ids, used


def main():
    argv, skip = [], set()
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--skip":
            skip.add(next(it))
        else:
            argv.append(a)
    if len(argv) < 2:
        sys.exit(__doc__)

    xlsx, ng = argv[0], 0
    z = zipfile.ZipFile(xlsx)
    paths = sheet_paths(z)

    images = sum(len(re.findall(r"<(?:\w+:)?(?:two|one)CellAnchor\b", z.read(n).decode()))
                 for n in z.namelist() if n.startswith("xl/drawings/drawing"))
    merges = sum(len(re.findall(r"<mergeCell ", z.read(n).decode()))
                 for n in paths.values())
    print("全体: シート %d 枚 / 画像 %d 枚 / 結合 %d 個" % (len(paths), images, merges))

    for a in argv[1:]:
        spec, dirs = a.split("=", 1)
        titles = spec.split("+")
        for title in titles:
            if title not in paths:
                sys.exit("シートが見つからない: %s (%s)" % (title, ", ".join(paths)))

        want, used = feature_ids(dirs.split(","), skip)
        got, dup, bad = set(), [], []
        print("\n=== %s" % " + ".join(titles))
        for title in titles:
            # 機械的な確認はシートごと。シナリオ ID だけ束ねた側で足し込む
            xml = z.read(paths[title]).decode()
            rows = {r: v for r, v in rows_of(xml).items() if r >= FIRST_ROW}
            pre = title + " の " if len(titles) > 1 else ""
            seen_no = set()
            data = 0
            for r, (ra, cells) in sorted(rows.items()):
                # **A〜D がすべて空の行は素通りする。** Excel で保存すると、使った範囲の
                # 下に `<row r="20" ht="15.75" customHeight="1" s="10"></row>` だけの
                # 空行が数百行書き出される (行の書式を触ると付く)。これをデータ行として
                # 数えると 1 シートで NG が数千件出て、**本体のシナリオ ID の判定が
                # 埋もれて読めなくなる** (2026-01-15 に 17644 件出た)。
                # 空行は表示にも印刷にも出ないので資料としては無害。
                if not any(cells.get(col, ("", "", ""))[2].strip() for col in "ABCD"):
                    continue
                data += 1
                got |= set(re.findall(r"\((%s)\)" % ID, cells.get("C", ("", "", ""))[2]))
                if "ht" in ra or "customHeight" in ra:
                    bad.append("%s%d 行に ht/customHeight が付いている" % (pre, r))
                for col in "ABCD":
                    if not cells.get(col, ("", "", ""))[2].strip():
                        bad.append("%s%s%d が空" % (pre, col, r))
                for col in "EFG":
                    if cells.get(col, ("", "", ""))[2].strip():
                        bad.append("%s%s%d が空でない" % (pre, col, r))
                no = cells.get("A", ("", "", ""))
                if no[1] != "inlineStr":
                    bad.append('%sA%d が t="%s" (inlineStr であること)' % (pre, r, no[1]))
                if no[2] in seen_no:
                    dup.append(pre + no[2])
                seen_no.add(no[2])
            print("  %-30s %-26s %d 行 (書き出しは %d 行)"
                  % (title, paths[title], data, len(rows)))

        for path, n in used:
            print("  feature %-52s %2d" % (os.path.relpath(path), n))
        if skip:
            print("  除外: %s" % ", ".join(sorted(skip)))
        print("  シナリオ ID: 資料 %d / feature %d" % (len(got), len(want)))
        for label, st in (("資料にあって feature に無い", got - want),
                          ("feature にあって資料に無い", want - got)):
            if st:
                ng += 1
                print("  NG %s (%d): %s" % (label, len(st), " ".join(sorted(st))))
        if dup:
            ng += 1
            print("  NG No. が重複: %s" % " ".join(sorted(dup)))
        for b in bad:
            ng += 1
            print("  NG %s" % b)
        if not (got - want or want - got or dup or bad):
            print("  OK")

    print("\n判定: %s" % ("OK" if ng == 0 else "NG (%d 件)" % ng))
    sys.exit(1 if ng else 0)


if __name__ == "__main__":
    main()
