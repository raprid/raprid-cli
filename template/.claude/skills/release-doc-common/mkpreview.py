"""確認用の xlsx を作る。AppleScript でシートを選ばせると AppleEvent が
タイムアウトする (-1712) ので、zip の中で activeTab と topLeftCell を直接書き換える。"""
import re, shutil, sys, zipfile

src, dst, tab, top = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
zin = zipfile.ZipFile(src)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for it in zin.infolist():
        d = zin.read(it.filename)
        if it.filename == "xl/workbook.xml":
            s = d.decode()
            s = re.sub(r'activeTab="\d+"', f'activeTab="{tab}"', s)
            if "activeTab" not in s:
                s = s.replace("<workbookView", f'<workbookView activeTab="{tab}"', 1)
            d = s.encode()
        elif it.filename == f"xl/worksheets/sheet{tab + 1}.xml":
            s = d.decode()
            s = re.sub(r"<sheetView ", f'<sheetView topLeftCell="{top}" ', s, count=1)
            s = s.replace("<sheetView ", '<sheetView tabSelected="1" ', 1)
            s = re.sub(r"<selection[^>]*/>", f'<selection activeCell="{top}" sqref="{top}"/>', s, count=1)
            d = s.encode()
        zout.writestr(it, d)
print("wrote", dst)
