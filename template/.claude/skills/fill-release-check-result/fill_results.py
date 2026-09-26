"""確認手順シートの**結果・確認者・確認日**を埋め、結果セルをエビデンスへのリンクにする。

    python fill_results.py <xlsx> <シート名> <マニフェスト.tsv>
        [--author "氏名"] [--date 2026/09/04] [--legend] [--dry-run]

マニフェストは 1 行 1 手順のタブ区切り。**No. は確認手順シートの A 列と一致させる。**

    No.  ⇥  結果  ⇥  エビデンスのラベル行  ⇥  備考(任意)
    1.1  ⇥  OK    ⇥  A4
    1.3  ⇥  一部OK ⇥  A4          ⇥ 残りは前提データを用意できず
    2.1  ⇥  未実施 ⇥                            ← 空ならリンクを張らない

* エビデンスのラベル行は**同じパートの確認エビデンスシート**の `A<n>` で書く
  (`--evidence` で別シートを指定できる)。**そのセルに見出しが入っているかを検証する** ——
  リンク先が空だと、クリックするまで誰も気づかない
* **`未実施` の行には確認者・確認日を書かない。** 誰も見ていない行に確認者名が入ると
  記録が嘘になる。`到達不可` は「前提を作れないと確かめた」結果なので**書く**
  （未実施の行だけを空欄にする）
* 結果は `OK` / `一部OK` / `NG` / `未実施` / `到達不可` のいずれか。
  **`NG` があれば最後に必ず目立たせて出す** (リリース可否の判断そのものなので、
  ほかの行に埋もれさせない)
* `--legend` を付けると A2 の凡例を**実際に使われた値だけ**から作り直す。
  使っていない値が凡例に残ると、読む人が「未実施が無いのか探し漏れたのか」を判断できない

■ 書き戻し方

`release-doc-common/README.md` の方針どおり **zipfile で該当シートの XML を 1 パートだけ
差し替える**。openpyxl で往復させると 17MB の画像を読み書きし直すことになり、
壊れたときの影響が資料全体に及ぶ。**リンクは `location` 属性の内部リンク**なので
`_rels` を触る必要はない (外部リンクだけが rels を要求する)。

セルは雛形の性質を守って `t="inlineStr"` で書く。`sharedStrings.xml` を作ってしまうと
「1 パートだけ差し替えられる」という前提が崩れる。

■ 書式 (`s=`)

| 列 | リンクあり | リンクなし |
| --- | --- | --- |
| E 結果 | `s=8` (青・下線 + 罫線) | `s=5` |
| F 確認者 / G 確認日 | `s=5` | `s=5` |

**雛形にはこの `s=8` が入っていない** (`release-doc-common/release-procedure-template.xlsx`
の `cellXfs` は s=0〜7)。無いまま `s="8"` と書くと存在しない書式を指すので、
**無ければ `styles.xml` の末尾に足してから使う**。既にある書式を詰め替えることはしない ——
`s=` の番号は `release-doc-common/README.md` のとおり各スクリプトが決め打ちしているので、
**番号が動くと資料全体の書式が総崩れになる。**
"""
import os, re, shutil, sys, zipfile
from xml.sax.saxutils import escape, quoteattr

RESULTS = ('OK', '一部OK', 'NG', '未実施', '到達不可')
# 確認者・確認日を書かない結果。**誰も見ていない行に確認者名を書くのは虚偽の記録になる。**
# 「到達不可」は書く —— 前提を作れないと**確かめた**結果なので、確認の行為はあった
NO_WITNESS = ('未実施',)
LEGEND = {
    'OK': 'OK = 期待値をすべて確認',
    '一部OK': '一部OK = 期待値の一部のみ確認（残りは前提データを用意できず）',
    'NG': 'NG = 期待値と違う挙動',
    '未実施': '未実施 = 前提・権限・環境が用意できず未実行',
    '到達不可': '到達不可 = 前提そのものを作れず到達できない',
}
S_PLAIN = '5'   # 本文と同じ書式 (罫線あり・上下中央)
S_LINK = '8'    # 結果セルをリンクに見せる書式。**無ければ ensure_link_style が足す**
# s=8 が参照するフォント。s=5 のフォントに色と下線を足しただけ
LINK_FONT = ('<font><name val="游ゴシック" /><color rgb="FF0563C1" />'
             '<sz val="11" /><u val="single" /></font>')


def die(m):
    sys.exit(f'エラー: {m}')


def parse_args(argv):
    pos, o = [], dict(author=None, date=None, legend=False, dry=False, ev=None)
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--author':
            o['author'] = argv[i + 1]; i += 2
        elif a == '--date':
            o['date'] = argv[i + 1]; i += 2
        elif a == '--evidence':
            o['ev'] = argv[i + 1]; i += 2
        elif a == '--legend':
            o['legend'] = True; i += 1
        elif a == '--dry-run':
            o['dry'] = True; i += 1
        elif a.startswith('--'):
            die(f'知らない引数: {a}')
        else:
            pos.append(a); i += 1
    if len(pos) != 3:
        sys.exit(__doc__)
    return pos, o


def part_of(z, name):
    """シート名 -> xl/worksheets/sheetN.xml を workbook.xml と rels で解決する。"""
    wb = z.read('xl/workbook.xml').decode()
    rels = z.read('xl/_rels/workbook.xml.rels').decode()
    rid = None
    for tag in re.findall(r'<sheet\b[^>]*/?>', wb):
        d = dict(re.findall(r'(\w+(?::\w+)?)="([^"]*)"', tag))
        if d.get('name') == name:
            rid = d.get('r:id') or d.get('id')
    if rid is None:
        die(f'シート {name} が無い')
    for tag in re.findall(r'<Relationship\b[^>]*/?>', rels):
        d = dict(re.findall(r'(\w+)="([^"]*)"', tag))
        if d.get('Id') == rid:
            t = d['Target'].lstrip('/')
            return t if t.startswith('xl/') else 'xl/' + t
    die(f'{rid} の Relationship が無い')


def cells_of(xml):
    """{セル参照: 表示文字列} を inlineStr から作る。"""
    out = {}
    for c in re.findall(r'<c\b[^>]*?(?:/>|>.*?</c>)', xml, re.S):
        ref = re.search(r'\br="([A-Z]+\d+)"', c)
        if not ref:
            continue
        out[ref.group(1)] = ''.join(re.findall(r'<t[^>]*>(.*?)</t>', c, re.S))
    return out


def put(row_xml, col, row_no, s, text):
    """行 XML に <c r="col+row"> を差し込む / 差し替える。列順を保つ。"""
    ref = f'{col}{row_no}'
    cell = (f'<c r="{ref}" s="{s}" t="inlineStr"><is><t xml:space="preserve">'
            f'{escape(text)}</t></is></c>')
    pat = re.compile(r'<c\b[^>]*\br="' + ref + r'"(?:\s[^>]*)?(?:/>|>.*?</c>)', re.S)
    if pat.search(row_xml):
        return pat.sub(cell, row_xml, count=1)
    # 無ければ、自分より後ろの列の直前に入れる (列は昇順でなければならない)
    for c in re.finditer(r'<c\b[^>]*\br="([A-Z]+)' + str(row_no) + r'"', row_xml):
        if len(c.group(1)) > len(col) or (len(c.group(1)) == len(col) and c.group(1) > col):
            return row_xml[:c.start()] + cell + row_xml[c.start():]
    return re.sub(r'</row>$', cell + '</row>', row_xml)


def _items(styles, tag, child):
    """styles.xml の <tag> の中身を child 単位で数え上げる。"""
    m = re.search(r'<' + tag + r'\b[^>]*>(.*?)</' + tag + r'>', styles, re.S)
    if not m:
        die(f'styles.xml に <{tag}> が無い')
    return re.findall(r'<' + child + r'\b[^>]*?(?:/>|>.*?</' + child + r'>)',
                      m.group(1), re.S)


def _append(styles, tag, item):
    """<tag> の**末尾**に item を足し、count を 1 増やす。"""
    m = re.search(r'(<' + tag + r'\b[^>]*>)(.*?)(</' + tag + r'>)', styles, re.S)
    head = re.sub(r'count="(\d+)"', lambda g: f'count="{int(g.group(1)) + 1}"',
                  m.group(1), count=1)
    return styles[:m.start()] + head + m.group(2) + item + m.group(3) + styles[m.end():]


def ensure_link_style(styles):
    """結果セルを青・下線で見せる書式を確保し (s の番号, 直した styles.xml か None) を返す。

    雛形の `cellXfs` は s=0〜7 で、リンク用の書式が入っていない。**足すのは必ず末尾。**
    既にある番号を詰め替えると、ほかのスクリプトが決め打ちしている `s=` が全部ずれる。
    雛形から作った直後なら追加位置はちょうど 8 になり、S_LINK と一致する。

    足す書式は**本文 (s=5) の複製で、フォントだけ差し替えたもの**にする。
    罫線や配置を独自に決めると、隣の列と枠線が合わなくなる。
    """
    fonts = _items(styles, 'fonts', 'font')
    xfs = _items(styles, 'cellXfs', 'xf')
    if len(xfs) <= int(S_PLAIN):
        die(f'cellXfs が {len(xfs)} 個しかない。リリース資料の雛形から作った xlsx ではない')
    plain = xfs[int(S_PLAIN)]
    border = dict(re.findall(r'(\w+)="([^"]*)"', plain)).get('borderId', '1')
    ul = {str(i) for i, f in enumerate(fonts) if re.search(r'<u\b', f)}
    for i, xf in enumerate(xfs):          # 既にあるなら、その番号をそのまま使う
        d = dict(re.findall(r'(\w+)="([^"]*)"', xf))
        if d.get('fontId') in ul and d.get('borderId') == border:
            return str(i), None
    new_xf = re.sub(r'fontId="\d+"', f'fontId="{len(fonts)}"', plain, count=1)
    styles = _append(styles, 'fonts', LINK_FONT)
    styles = _append(styles, 'cellXfs', new_xf)
    return str(len(xfs)), styles


(X, SHEET, MAN), o = parse_args(sys.argv[1:])
ev_sheet = o['ev'] or SHEET.replace('確認手順', '確認エビデンス', 1)

rows = []
with open(MAN, encoding='utf-8') as fp:
    for ln, line in enumerate(fp, 1):
        line = line.rstrip('\n')
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        f = line.split('\t')
        if len(f) < 2:
            die(f'{MAN}:{ln} タブ区切りで No. と結果が要る: {line!r}')
        no, res = f[0].strip(), f[1].strip()
        ev = f[2].strip() if len(f) > 2 else ''
        if res not in RESULTS:
            die(f'{MAN}:{ln} 結果 {res!r} は {"/".join(RESULTS)} のいずれかにする')
        if ev and not re.fullmatch(r'A\d+', ev):
            die(f'{MAN}:{ln} エビデンスは A<行番号> の形にする: {ev!r}')
        rows.append((no, res, ev))
if not rows:
    die(f'{MAN} に行が無い')

z = zipfile.ZipFile(X)
part = part_of(z, SHEET)
xml = z.read(part).decode()
ev_part = part_of(z, ev_sheet)
ev_cells = cells_of(z.read(ev_part).decode())
styles = z.read('xl/styles.xml').decode()
z.close()

S_LINK, new_styles = ensure_link_style(styles)

# A 列の No. -> 行番号
no2row = {}
for ref, txt in cells_of(xml).items():
    if ref.startswith('A') and txt.strip():
        no2row.setdefault(txt.strip(), int(ref[1:]))

miss = [no for no, _, _ in rows if no not in no2row]
if miss:
    die(f'{SHEET} の A 列に無い No.: {miss[:10]}')
dup = [no for no, _, _ in rows if [r[0] for r in rows].count(no) > 1]
if dup:
    die(f'マニフェストに同じ No. が複数ある: {sorted(set(dup))[:10]}')
dangling = [(no, ev) for no, _, ev in rows if ev and not ev_cells.get(ev, '').strip()]
if dangling:
    die(f'{ev_sheet} のリンク先に見出しが無い: {dangling[:10]}')

links, used = [], []
for no, res, ev in rows:
    r = no2row[no]
    rp = re.compile(r'<row r="' + str(r) + r'"(?:\s[^>]*)?>.*?</row>', re.S)
    m = rp.search(xml)
    if not m:
        die(f'{SHEET} に行 {r} (No. {no}) が無い')
    body = m.group(0)
    body = put(body, 'E', r, S_LINK if ev else S_PLAIN, res)
    witness = res not in NO_WITNESS
    if o['author'] and witness:
        body = put(body, 'F', r, S_PLAIN, o['author'])
    if o['date'] and witness:
        body = put(body, 'G', r, S_PLAIN, o['date'])
    xml = xml[:m.start()] + body + xml[m.end():]
    if ev:
        # シート名は ' で囲む。名前の中の ' は 2 つ重ねて逃がす (Excel の書き方)
        loc = "'" + ev_sheet.replace("'", "''") + "'!" + ev
        links.append(f'<hyperlink ref="E{r}" location={quoteattr(loc)} '
                     f'tooltip={quoteattr(f"エビデンス: {ev_sheet} {ev}")} '
                     f'display={quoteattr(res)} />')
    used.append(res)

xml = re.sub(r'<hyperlinks>.*?</hyperlinks>', '', xml, flags=re.S)
if links:
    block = '<hyperlinks>' + ''.join(links) + '</hyperlinks>'
    # <hyperlinks> は <sheetData> の後、<pageMargins> の前に置く
    if '<pageMargins' in xml:
        xml = xml.replace('<pageMargins', block + '<pageMargins', 1)
    else:
        xml = xml.replace('</worksheet>', block + '</worksheet>', 1)

if o['legend']:
    order = [k for k in RESULTS if k in used]
    txt = ('結果の凡例  ' + ' / '.join(LEGEND[k] for k in order)
           + ('。NG は 1 件もありません。' if 'NG' not in used else '。')
           + '結果セルは対応するエビデンス画像の見出し行へのリンクになっています。')
    m = re.search(r'<row r="2"(?:\s[^>]*)?>.*?</row>', xml, re.S)
    if not m:
        die('A2 の行が無いので凡例を書けない')
    xml = xml[:m.start()] + put(m.group(0), 'A', 2, '2', txt) + xml[m.end():]

n_link = len(links)
print(f'{SHEET}  ({part})')
print(f'  埋めた行 {len(rows)}  / リンク {n_link}  / リンクなし {len(rows) - n_link}')
print(f'  結果セルの書式 s={S_LINK}'
      + ('  ★無かったので styles.xml の末尾に足した' if new_styles else '  (既にある)'))
for k in RESULTS:
    if used.count(k):
        print(f'    {k:<6} {used.count(k):>3} 行')
n_wit = sum(1 for r in used if r not in NO_WITNESS)
print(f'  確認者 {o["author"] or "(触らない)"}  確認日 {o["date"] or "(触らない)"}'
      f'  -> {n_wit} 行に記入 / {len(used) - n_wit} 行は空のまま '
      f'({"・".join(NO_WITNESS)} は誰も確認していないため)')
if o['legend']:
    print('  A2 の凡例を作り直した')

if o['dry']:
    print('\n--dry-run なので書いていない')
else:
    new = {part: xml}
    if new_styles:
        new['xl/styles.xml'] = new_styles
    tmp = X + '.tmp'
    with zipfile.ZipFile(X) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for it in zin.infolist():
            b = new.get(it.filename)
            zout.writestr(it, b.encode() if b is not None else zin.read(it.filename))
    shutil.move(tmp, X)
    print(f'\n{X} を更新した ({os.path.getsize(X):,} バイト / '
          f'差し替えたのは {"・".join(new)} だけ)')

if 'NG' in used:
    ng = [no for no, res, _ in rows if res == 'NG']
    print('\n' + '=' * 60)
    print(f'★ NG が {len(ng)} 件ある: {", ".join(ng)}')
    print('  リリース可否の判断に直結する。埋めて終わりにせず、必ず報告する。')
    print('=' * 60)
