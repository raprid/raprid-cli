# release-doc-common

リリース資料 (`docs/official/<案件名>/release-procedure.xlsx`) を作る 3 つのスキルが
共有する資材。**SKILL.md を持たないので単体では起動しない。**

* [build-release-diff-sheet](../build-release-diff-sheet/SKILL.md) — MR の差分を撮って
  「プログラムの変更箇所」シートに貼る
* [build-release-check-sheet](../build-release-check-sheet/SKILL.md) — Gherkin の手順書から
  「確認手順」シートを起こす
* [fill-release-check-result](../fill-release-check-result/SKILL.md) — 確認手順を実施環境で
  実行し、結果と「確認エビデンス」シートを埋める

**画像を貼る一連のスクリプト (`relayout.py` 以下) はここに置いてある。**
変更箇所シートとエビデンスシートで同じものが要るためで、
**一方のスキルからもう一方を呼ばせない** (3 つは独立に起動できる)。

雛形は同梱の `release-procedure-template.xlsx` を正とする。

## 実行環境

使うスクリプトに応じて `openpyxl` / `Pillow` / `numpy` / `pyoxipng` が要る。
既存の環境に入っているか確認し、不足している場合は専用 venv に入れる。

```sh
python3 -m venv <作業ディレクトリ>/venv
<作業ディレクトリ>/venv/bin/pip install openpyxl Pillow numpy pyoxipng
```

以降の例では `$PY` をこの venv の python とする。
**scratchpad は中身が丸ごと消えることがある**ので、venv も作り直す前提で置く。

Claude Code / Codex とも [共通実行ルール](../runtime.md) に従う。
シェル例のスクリプト名はこのディレクトリ基準の略記なので、実行時は入力・出力も含めて
絶対パスまたは管理リポジトリのルート相対パスに揃える。
GUI 操作例は macOS + Excel の場合。利用できない場合も生成と機械検証を先に行い、
目視が未実施であることを明記する。

## 雛形 xlsx (`release-procedure-template.xlsx`)

4 シート。`{PART}` (パート名) と `{ENV}` (実施環境) がプレースホルダ。

| # | シート | 中身 |
| --- | --- | --- |
| 1 | `リリース手順` | A1〜A5。プロジェクトに合わせて手順を更新する |
| 2 | `プログラムの変更箇所_{PART}` | A1 `■ 変更内容メモ` のみ。列幅は A〜L の合計が 713px |
| 3 | `確認手順_{PART}` | A1 `{ENV}で、以下の内容を確認致しました。` + 3 行目のヘッダー 7 列 |
| 4 | `確認エビデンス_{PART}` | A1 `{PART}での確認エビデンス` のみ |

**全セルを `t="inlineStr"` で書いてあり、`sharedStrings.xml` を持たない。**
これが効いて「**画像を貼ったあとでも zipfile で sheet XML を 1 パートだけ差し替えられる**」が
成立する。文字列テーブルを共有していないので、1 シートを丸ごと書き換えても他シートに響かない。
雛形を直すときもこの性質を壊さないこと。

### `styles.xml` の `cellXfs`

雛形は `fonts` 4 / `fills` 3 / `borders` 2 / `cellStyleXfs` 1 / **`cellXfs` 8 (s=0〜7)**。
スクリプトはこの `s=` 番号を決め打ちしているので、**番号を動かすと書式が総崩れになる。**
足すときは**必ず末尾**に足し、既にあるものを詰め替えない。

| `s` | 書式 | 使う場所 |
| --- | --- | --- |
| 0 | 既定 | — |
| 1 | 游ゴシック 11 | — |
| 2 | 游ゴシック 11 | A1 の見出し / 確認手順の A・E・F・G の下地 |
| 3 | 罫線 + 網掛け + center/center | 確認手順のヘッダー行 |
| 4 | 3 + `wrapText` | 確認手順の C3 |
| 5 | 罫線 + vertical=center | 確認手順の A・E・F・G (折り返し無し) |
| 6 | 5 + `wrapText` | 確認手順の B・C・D |
| 7 | 游ゴシック **20pt 太字** | 変更箇所のファイル名の行 |
| 8 | 5 + 青 (`FF0563C1`) と下線 | 確認手順の E 列 (エビデンスへのリンク) |

**`s=8` は雛形に入っていない。** リンクを張るのは結果の記入時だけなので、
`fill-release-check-result/fill_results.py` が**無ければ `styles.xml` の末尾に自分で足す**
(足す中身は s=5 の複製でフォントだけ差し替えたもの。罫線を独自に決めると隣の列と枠が合わない)。
雛形から作った直後なら追加位置はちょうど 8 になる。

確認は `$PY dump_xlsx.py <xlsx> --styles`。

## スクリプト

### `init_workbook.py` — 土台を作る

```sh
$PY init_workbook.py <出力先.xlsx> "管理画面" "利用者画面"   # 複数パート
$PY init_workbook.py <出力先.xlsx> --single                 # 単一パート・サフィックス無し
$PY init_workbook.py <出力先.xlsx> --env ステージング環境 "管理画面"  # A1 の環境名を変える (既定は開発環境)
```

シートの並びは **リリース手順 → 変更箇所×N → 確認手順×N → 確認エビデンス×N**。

**openpyxl は使っていない。** `copy_worksheet` はスタイルを複製して `cellXfs` が増え、
上の表の `s=` 番号がずれる。zip のパートを複製して `workbook.xml` /
`xl/_rels/workbook.xml.rels` / `[Content_Types].xml` を書き直している。

### `edit_sheets.py` — シートを足す / 改名する

```sh
$PY edit_sheets.py <xlsx> \
    --rename "確認手順_管理画面=確認手順_管理画面" \
    --add    "確認手順_利用者画面=確認手順@after:確認手順_管理画面" \
    --like   "確認エビデンス_利用者画面=確認エビデンス_管理画面@rows:3@after:確認エビデンス_管理画面"
```

`init_workbook.py` はゼロから作る専用 (種類ごとにパート名を変えられない) なので、
**画像を貼った後の資料にシートを足す / 分けるのはこちら。** `--out` を省くと元を書き換える
(`.bak` を残す)。既存の資料をパートごとに分割するときにも使える。

* **`--add` は雛形から起こす** (`{PART}` はシート名の `_` 以降、`{ENV}` は `--env`)。
  **`--like` は既存シートの列幅と先頭 N 行だけを写す** —
  確認エビデンスは雛形が 1 列 1 行しか持たないので、体裁を揃えるにはこちら
* **`--rename` は `<sheet name=>` だけでなく全シートの `location=` / `tooltip=` も直す。**
  `'確認エビデンス_管理画面'!A213` の形の内部リンクは
  **クリックするまで壊れたと気づけない**
* **既存の `sheetN.xml` の番号と `rId` は動かさない。**
  `xl/worksheets/_rels/sheetN.xml.rels` が画像をパート名で束ねているため。
  新規は空き番号の最大 + 1。**並び順は `<sheet>` 要素の順で決まる**のでパート番号と
  一致しなくてよい (この後 `relayout.py` が openpyxl の往復でパートを振り直すので、
  番号に意味を持たせてはいけない)
* **`styles.xml` と `docProps/app.xml` は触らない。** 雛形の `s=` はすべて実物にもあり、
  `TitlesOfParts` がシート数と食い違っても Excel で開けることは実測済み

### `dump_xlsx.py` — 中身をテキストで見る

```sh
$PY dump_xlsx.py <xlsx>                # 全シート
$PY dump_xlsx.py <xlsx> "確認手順_運用画面"
$PY dump_xlsx.py <xlsx> --styles
```

行頭のラベル (`sheet` / `列幅` / `セル` / `画像` / `行高`) で grep して別のファイルと
突き合わせられる。**スタイル番号とアンカーは openpyxl を経由せず zip の生 XML から読む** —
openpyxl は `s=` を持ち回らないため。

### `blank_results.py` — 実施前の版を作る

**記入済みの資料から、確認結果とエビデンスを落とした版**を書き出す
(`fill_results.py` と `place_images.py` の巻き戻し)。別環境で確認をやり直すときや、
実施前に手順をレビューへ出すときに使う。

```sh
$PY blank_results.py <入力.xlsx> <出力.xlsx> [--keep-evidence] [--dry-run]
```

* シートは名前の頭 (`確認手順` / `確認エビデンス`) で選ぶ。**パートごとに分かれていても全部拾う**
* 確認手順シートは **E・F・G を値の無いセル (`<c r="E5" s="5" t="n" />`) にし**、
  A2 の凡例と結果セルのリンクを落とす。**凡例は実際に使った結果から作るもの**なので、
  実施前に残っていると嘘になる
* 確認エビデンスシートは**表題 (A1) だけ残して画像・土台の結合・ラベル行を落とす**。
  雛形の確認エビデンスシートと同じ姿に戻るので、そのまま `relayout.py` から貼り直せる。
  `--keep-evidence` で触らずに残せる
* **落とすのはエビデンス側の `drawing` からしか参照されていない `xl/media/*` だけ。**
  プログラムの変更箇所シートの画像は残す。参照の集合を取ってから消しているので、
  同じ画像を両方が参照していれば残る。`[Content_Types].xml` の `<Override>` も一緒に外す
* **入力と出力が同じパスならエラーにする** (元の資料を上書きして結果を失わないため)
* **A1 の環境名は書き換えない。** 別環境で実施するなら開いて直す

### 画像を貼る 5 段 — `relayout.py` / `place_images.py` / `verify_floating.py` / `split_tall.py` / `verify_cuts.py`

**貼るのは器 -> 画像 -> 検証の順**で、途中の xlsx を捨てずに残す (失敗しても戻せる)。

```sh
$PY split_tall.py <画像...> --max 2048 --check /tmp/cuts.png   # 長辺 2048px 以下に割る
$PY verify_cuts.py <ディレクトリ>                               # 接合面に文字が乗っていないか
$PY relayout.py <in.xlsx> shell.xlsx manifest.tsv --width <表示px> --lastcol 12
$PY place_images.py shell.xlsx <out.xlsx>                       # shell.xlsx.plan を読む
$PY verify_floating.py <out.xlsx>
```

`manifest.tsv` は `シート名 ⇥ 順番 ⇥ ラベル ⇥ 画像パス`。
**ラベルが空の行は「継ぎ」**で、直前の画像の真下にラベル行も空行も挟まずに置く。

* **`--width` は「表示幅」で、画像の画素幅とは別物。** 変更箇所シートは 713px 表示、
  確認エビデンスシートは 1512px 表示。**画素はこれより大きくしてよい** ——
  表示 1512px・画素 2016px にすると、Retina で描画側が引き伸ばすぶんを先に持たせられる
  (`fill-release-check-result/normalize.py`)
* `verify_floating.py` は**表示幅の揃い**と**画素の長辺 2048px** を別々に見る。
  2048px はドライブが縮小を始める境界で、**幅にも効く**
* `fix_anchors.py` は既にある `twoCellAnchor` の資料を `oneCellAnchor` + 実寸に直す修復用
* **組み替えでは `relayout.py` が旧レイアウトのラベル行の残骸を残す。**
  値が無く書式だけ (`<c r="A1334" s="7" t="n" />`) のセルが旧ラベル行に残り、
  `<dimension>` が実際の末尾より下まで伸びる。**見た目は空行なので気づけないが、
  Ctrl+End とスクロールバーがそこまで飛ぶ。** 組み替えた後は
  `dump_xlsx.py` で `dimension` と最後の画像の行を突き合わせ、
  食い違っていたら値の無い `s=7` の行を消して `dimension` を張り直す
  （不要行が残ると末尾が大きくずれる）

### `mkpreview.py` — 実機で目視する

```sh
$PY mkpreview.py <in.xlsx> <prev.xlsx> <タブ番号(0起点)> <左上セル>
open -a "Microsoft Excel" <prev.xlsx>
```

AppleScript でシートを選ばせると AppleEvent が 120 秒でタイムアウトする (-1712) ので、
zip の中で `activeTab` と `topLeftCell` を書き換えたファイルを作って開く。
**開いてから 14 秒ほど待つ** (3 秒では間に合わない)。前面化は
`osascript -e 'tell application "Microsoft Excel" to activate'`、撮影は `screencapture -x`。

## 全体で守ること

* **画像は `oneCellAnchor` + 明示 `<ext>` で貼る。`twoCellAnchor` は使わない。**
  `twoCellAnchor` は大きさを行高の合計から決めるので、行高を丸める描画系
  (Google スプレッドシート等) で**縦横比が崩れてラベル行に被る**。
  画像を入れる結合セルは「矩形」ではなく**土台**として、18.0pt の整数行だけで
  画像より必ず高く作る (端数行を残すと土台が縮む)
* **文字だけ直すときは zipfile で該当する sheet XML の 1 パートだけを差し替える。**
  `oneCellAnchor` は openpyxl の往復でも落ちない（大容量の資料でも都度検証すること）。
  加わるのは `<a:ln><a:prstDash val="solid"/>` と `mergeCell` の並び替えだけで、
  `inlineStr` も `sharedStrings.xml` 無しも保たれた) が、
  **17MB の画像を読み書きし直すぶん遅く、壊れたときの影響が資料全体に及ぶ。**
  かつては `editAs="oneCell"` が落ちるため zip 直叩きが必須だったが、
  `editAs` を使わなくなったので今は「速さと影響範囲」の理由で選ぶ
* **`<col>` / `<row>` / `<Relationship>` の属性の並び順は openpyxl と Excel で違う。**
  `<col min= max= width=>` の順を前提にした正規表現は openpyxl 製ファイルにマッチせず、
  既定幅で計算して幅を誤判定する。`dict(re.findall(r'(\w+)="([^"]*)"', tag))` で辞書にして読む
* **シート名から XML のパスを引くときは `workbook.xml` → rels で解決する。**
  `sheet4.xml` の決め打ちはパート数が変わると壊れる
* 列幅の px 換算は `px = round(width × 7) + 5` (標準フォントが Calibri 11)。行高 18pt = 24px
