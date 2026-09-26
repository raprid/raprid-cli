"""リリース資料の土台となる xlsx を、雛形からパート数ぶん展開して作る。

    python init_workbook.py <出力先.xlsx> "管理画面" "運用画面"   # 7 シート
    python init_workbook.py <出力先.xlsx> --single                        # 4 シート (サフィックス無し)
    python init_workbook.py <出力先.xlsx> --env ステージング環境 "運用画面"

シートの並びは リリース手順 → 変更箇所×N → 確認手順×N → 確認エビデンス×N。

**openpyxl は使わない。** `copy_worksheet` はスタイルを複製して `cellXfs` が増え、
スクリプトが決め打ちしている `s=` 番号 (README の表) がずれる。
zip のパートを複製して workbook.xml / rels / [Content_Types].xml を書き直す。
"""
import os, re, sys, zipfile

TPL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "release-procedure-template.xlsx")
NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument"
# 雛形のシート番号 -> 役割。1 はパートに依らず 1 枚だけ
KIND = {2: "プログラムの変更箇所", 3: "確認手順", 4: "確認エビデンス"}


def parse_argv(argv):
    out, env, single = [], "開発環境", False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--single":
            single = True
        elif a == "--env":
            i += 1
            env = argv[i]
        elif a.startswith("--"):
            sys.exit("不明なオプション: %s" % a)
        else:
            out.append(a)
        i += 1
    return out, env, single


def main():
    args, env, single = parse_argv(sys.argv[1:])
    if not args:
        sys.exit(__doc__)
    dst, parts = args[0], args[1:]
    if single:
        if parts:
            sys.exit("--single とパート名は同時に指定できない")
        parts = [""]          # サフィックス無し（単一パート型）
    elif not parts:
        sys.exit("パート名を 1 つ以上並べるか --single を指定する")

    zin = zipfile.ZipFile(TPL)
    tpl = {n: zin.read(n).decode() for n in zin.namelist()}

    # (シート名, 雛形のシート番号) を最終的な並び順に組み立てる
    plan = [("リリース手順", 1)]
    for n in (2, 3, 4):
        for p in parts:
            plan.append((KIND[n] + ("_" + p if p else ""), n))

    out = {
        "_rels/.rels": tpl["_rels/.rels"],
        "docProps/app.xml": tpl["docProps/app.xml"],
        "docProps/core.xml": tpl["docProps/core.xml"],
        "xl/styles.xml": tpl["xl/styles.xml"],
        "xl/theme/theme1.xml": tpl["xl/theme/theme1.xml"],
    }
    for i, (name, src) in enumerate(plan):
        s = tpl["xl/worksheets/sheet%d.xml" % src]
        p = parts[(i - 1) % len(parts)] if src != 1 else ""
        # --single はサフィックス無しなので「{PART}での確認エビデンス」の助詞ごと落とす
        s = s.replace("{PART}での", p + "での" if p else "").replace("{PART}", p)
        s = s.replace("{ENV}", env)
        out["xl/worksheets/sheet%d.xml" % (i + 1)] = s

    out["xl/workbook.xml"] = re.sub(
        r"<sheets>.*?</sheets>",
        "<sheets>%s</sheets>" % "".join(
            '<sheet name="%s" sheetId="%d" state="visible" r:id="rId%d" />' % (n, i + 1, i + 1)
            for i, (n, _) in enumerate(plan)),
        tpl["xl/workbook.xml"], flags=re.S)

    out["xl/_rels/workbook.xml.rels"] = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s'
        '<Relationship Type="%s/styles" Target="styles.xml" Id="rId%d" />'
        '<Relationship Type="%s/theme" Target="theme/theme1.xml" Id="rId%d" /></Relationships>'
    ) % ("".join('<Relationship Type="%s/worksheet" Target="/xl/worksheets/sheet%d.xml" Id="rId%d" />'
                 % (NS, i + 1, i + 1) for i in range(len(plan))),
         NS, len(plan) + 1, NS, len(plan) + 2)

    out["[Content_Types].xml"] = re.sub(
        r'(<Override PartName="/xl/worksheets/sheet1\.xml".*?)(?=<Override PartName="/xl/workbook\.xml")',
        "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="%s.spreadsheetml.worksheet+xml" />'
                % (i + 1, CT) for i in range(len(plan))),
        tpl["[Content_Types].xml"], flags=re.S)

    order = ["[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml",
             "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/theme/theme1.xml"]
    order += ["xl/worksheets/sheet%d.xml" % (i + 1) for i in range(len(plan))]
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for name in order:
            z.writestr(name, out[name].encode("utf-8"))

    print("%s (%d シート)" % (dst, len(plan)))
    for i, (name, _) in enumerate(plan):
        print("  %d %-40s -> xl/worksheets/sheet%d.xml" % (i, name, i + 1))


if __name__ == "__main__":
    main()
