"""確認結果とエビデンスを落として、**確認手順を実施する前の版**を作る。

    python blank_results.py <入力.xlsx> <出力.xlsx> [--keep-evidence] [--dry-run]

`fill_results.py` と `place_images.py` がやったことを巻き戻す。手順 (A〜D 列) と
リリース手順・プログラムの変更箇所はそのまま残るので、**そのまま渡して実施できる版**になる。

* 確認手順シート — **E 結果 / F 確認者 / G 確認日を空にし**、結果セルのリンクと
  A2 の凡例を消す。凡例は実際に使った結果から作るものなので、実施前に残すと嘘になる
* 確認エビデンスシート — **表題 (A1) だけ残して画像・土台の結合・ラベル行を落とす**。
  雛形 (`release-procedure-template.xlsx`) の確認エビデンスシートと同じ姿に戻る。
  `--keep-evidence` を付けると触らない (結果だけ空にしたいとき)
* シートは名前の頭 (`確認手順` / `確認エビデンス`) で選ぶ。パートごとに分かれていても全部拾う

**A1 の環境名は書き換えない。** 別の環境で実施するなら、開いて直す
(`開発環境で、以下の内容を確認致しました。` の部分)。

■ 落とす画像

エビデンスの `drawing` パートとその rels、**そこからしか参照されていない
`xl/media/*` を消す**。プログラムの変更箇所シートの画像は残るので、
**この 2 つを混同しないよう参照の集合を取ってから消す** (同じ画像を両方が
参照していたら残す)。`[Content_Types].xml` の `<Override>` も一緒に外す。

■ 書き戻し方

`release-doc-common/README.md` の方針どおり zip のパートを 1 つずつ生コピーし、
差し替える / 落とすものだけ入れ替える。openpyxl は使わない —— 往復させると
`oneCellAnchor` の `<ext>` と書式が詰め替わり、残す側の画像まで巻き込む。
"""
import os, re, shutil, sys, zipfile

CT = '[Content_Types].xml'
S_PLAIN = '5'   # 本文と同じ書式 (罫線あり)。空セルも罫線は残す


def die(m):
    sys.exit(f'エラー: {m}')


def parse_args(argv):
    pos, o = [], dict(keep_ev=False, dry=False)
    for a in argv:
        if a == '--keep-evidence':
            o['keep_ev'] = True
        elif a == '--dry-run':
            o['dry'] = True
        elif a.startswith('--'):
            die(f'知らない引数: {a}')
        else:
            pos.append(a)
    if len(pos) != 2:
        sys.exit(__doc__)
    return pos, o


def rels_of(z, part):
    """パートの _rels を {Id: ターゲットのパート名} で返す。無ければ空。"""
    d, b = os.path.split(part)
    rp = f'{d}/_rels/{b}.rels'
    if rp not in z.namelist():
        return rp, {}
    out = {}
    for tag in re.findall(r'<Relationship\b[^>]*/?>', z.read(rp).decode()):
        a = dict(re.findall(r'(\w+)="([^"]*)"', tag))
        t = a['Target'].lstrip('/').replace('../', '')
        out[a['Id']] = t if t.startswith('xl/') else 'xl/' + t
    return rp, out


def sheets_of(z):
    """[(シート名, パート名)] を workbook.xml の <sheet> の順で返す。"""
    wb = z.read('xl/workbook.xml').decode()
    _, rid2part = rels_of(z, 'xl/workbook.xml')
    out = []
    for tag in re.findall(r'<sheet\b[^>]*/?>', wb):
        a = dict(re.findall(r'(\w+(?::\w+)?)="([^"]*)"', tag))
        rid = a.get('r:id') or a.get('id')
        if rid not in rid2part:
            die(f'シート {a.get("name")} の Relationship ({rid}) が無い')
        out.append((a['name'], rid2part[rid]))
    return out


def header_row(xml):
    """E 列が「結果」の行を見出し行として返す。"""
    for m in re.finditer(r'<row r="(\d+)"(?:\s[^>]*)?>(.*?)</row>', xml, re.S):
        c = re.search(r'<c\b[^>]*\br="E' + m.group(1) + r'"(?:\s[^>]*)?>(.*?)</c>',
                      m.group(2), re.S)
        if c and '結果' in ''.join(re.findall(r'<t[^>]*>(.*?)</t>', c.group(1), re.S)):
            return int(m.group(1))
    die('E 列が「結果」の見出し行が見つからない。確認手順シートではない')


def blank_steps(xml):
    """E・F・G を空にし、凡例とリンクを落とす。(新しい XML, 空にした行数) を返す。"""
    head = header_row(xml)
    n = 0

    def one(m):
        nonlocal n
        r, body = int(m.group(1)), m.group(0)
        if r <= head:
            return body
        hit = False
        for col in ('E', 'F', 'G'):
            pat = re.compile(r'<c\b[^>]*\br="' + col + str(r) +
                             r'"(?:\s[^>]*)?(?:/>|>.*?</c>)', re.S)
            if pat.search(body):
                hit = True
                # 値の無いセル。s= は残して罫線を保つ (fill_results.py が書く形と同じ)
                body = pat.sub(f'<c r="{col}{r}" s="{S_PLAIN}" t="n" />', body, count=1)
        n += 1 if hit else 0
        return body

    xml = re.sub(r'<row r="(\d+)"(?:\s[^>]*)?>.*?</row>', one, xml, flags=re.S)
    # A2 の凡例。雛形の確認手順シートは 2 行目にセルを持たない
    xml = re.sub(r'(<row r="2"(?:\s[^>]*)?>).*?(</row>)', r'\1\2', xml, count=1, flags=re.S)
    xml = re.sub(r'<hyperlinks>.*?</hyperlinks>', '', xml, flags=re.S)
    return xml, n


def blank_evidence(xml):
    """表題 (1 行目) だけ残す。(新しい XML, 落とした結合の数) を返す。"""
    row1 = re.search(r'<row r="1"(?:\s[^>]*)?>.*?</row>', xml, re.S)
    if not row1:
        die('確認エビデンスシートに 1 行目 (表題) が無い')
    n_merge = len(re.findall(r'<mergeCell\b', xml))
    xml = re.sub(r'<dimension\b[^>]*/>', '<dimension ref="A1:A1" />', xml, count=1)
    # 列幅は A だけ残す。画像を貼るときに relayout.py が引き直す
    xml = re.sub(r'<cols>.*?</cols>',
                 '<cols><col width="8.699999999999999" customWidth="1" min="1" max="1" /></cols>',
                 xml, count=1, flags=re.S)
    xml = re.sub(r'<sheetData>.*?</sheetData>', '<sheetData>' + row1.group(0) + '</sheetData>',
                 xml, count=1, flags=re.S)
    xml = re.sub(r'<mergeCells\b[^>]*>.*?</mergeCells>', '', xml, flags=re.S)
    xml = re.sub(r'<mergeCells\b[^>]*/>', '', xml)
    xml = re.sub(r'<drawing\b[^>]*/>', '', xml)
    return xml, n_merge


(SRC, DST), o = parse_args(sys.argv[1:])
if os.path.abspath(SRC) == os.path.abspath(DST):
    die('入力と出力が同じファイル。別名にする (元の資料を壊さないため)')

z = zipfile.ZipFile(SRC)
new, drop, log = {}, set(), []

for name, part in sheets_of(z):
    if name.startswith('確認手順'):
        xml, n = blank_steps(z.read(part).decode())
        new[part] = xml
        log.append(f'  {name:<26} 結果・確認者・確認日を空にした ({n} 行)')
    elif name.startswith('確認エビデンス') and not o['keep_ev']:
        rp, rels = rels_of(z, part)
        xml, n_merge = blank_evidence(z.read(part).decode())
        new[part] = xml
        n_img = 0
        for rid, tgt in rels.items():
            if '/drawings/' not in tgt:
                continue
            drop.add(tgt)
            drp, drels = rels_of(z, tgt)
            drop.add(drp)
            n_img += sum(1 for t in drels.values() if '/media/' in t)
        # rels は drawing しか持っていないので、空になったら消す
        rest = {i: t for i, t in rels.items() if t not in drop}
        if rest:
            die(f'{name} の rels に drawing 以外の参照がある: {rest}')
        drop.add(rp)
        log.append(f'  {name:<26} 画像 {n_img} 枚と土台 {n_merge} 個を落として表題だけにした')

# 残る側 (プログラムの変更箇所など) がまだ参照している画像は消さない
keep_media = set()
for n in z.namelist():
    if '/drawings/' in n and n.endswith('.rels') and n not in drop:
        _, r = rels_of(z, n.replace('/_rels/', '/').replace('.rels', ''))
        keep_media |= {t for t in r.values() if '/media/' in t}
media = {n for n in z.namelist() if '/media/' in n}
drop |= (media - keep_media) if not o['keep_ev'] else set()

ct = z.read(CT).decode()
if drop:
    # 消したパートの <Override> を外す。残すと Excel が「修復しました」を出す
    ct = re.sub(r'<Override PartName="/(?:'
                + '|'.join(re.escape(p) for p in sorted(drop)) + r')"[^>]*/>', '', ct)
new[CT] = ct

print(f'{SRC} -> {DST}')
for line in log:
    print(line)
print(f'  残す画像 {len(keep_media)} 枚 / 落とす画像 {len(media - keep_media)} 枚'
      f' / 落とすパート {len(drop)} 個')

if o['dry']:
    print('\n--dry-run なので書いていない')
    sys.exit()

tmp = DST + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
    for it in z.infolist():
        if it.filename in drop:
            continue
        b = new.get(it.filename)
        zout.writestr(it, b.encode() if b is not None else z.read(it.filename))
z.close()
shutil.move(tmp, DST)
print(f'\n{DST} を書いた ({os.path.getsize(DST):,} バイト / '
      f'元は {os.path.getsize(SRC):,} バイト)')
