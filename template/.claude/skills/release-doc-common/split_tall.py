"""連結した 1 枚を、**Google ドライブでも劣化しない高さ**まで分割する。

    python split_tall.py <画像...> [--max 2048] [--win 120] [--out <dir>] [--dry-run] \
        [--check /tmp/cuts.png]

Google スプレッドシート (Office 編集モード) は画像データを**長辺 2048px に縮小してから**
配信する。高さがこれを超えると幅が 1426px から崩れ、表示枠に引き伸ばされて文字が潰れる。
劣化は高さに比例するので、`--max` 以下に収まるまで縦に切る。

* **切る位置は「文字の無い走査線」に限る。** 目標の高さちょうどでは行の途中を裂きうる
* **分割数は `ceil(高さ / max)`** で、残りを均等に割りながら 1 枚ずつ確定する
  (各枚が `max` 以下であることを不変条件として保つ)
* **P モード (256 色) の crop はパレットを引き継ぐ**ので、切っても再量子化は起きない。
  繋げ直すと元と画素単位で完全一致する (保存時の `optimize` でパレットの並びと
  未使用色は変わるため、バイト列ではなく RGB で一致する)

出力は `<元の名前>-1.png` … `-N.png`。`max` 以下の画像は触らず「無変換」と出す。
最後にマニフェスト用の行 (`ラベル ⇥ 画像パス`) を出す。**2 枚目以降のラベルは空**で、
relayout.py はこれを「継ぎ」と解釈してラベル行と空行を挟まずに直下へ置く。

`--check` は切り位置の前後 40px を並べた 1 枚を書き出す (seams.py と同じ考え方)。
**文字を裂いていないかは目で見て確かめる。** 走査線の判定は経験則なので、
ここを自動化された OK で済ませない。
"""
import io, math, os, sys
import numpy as np
from PIL import Image

try:
    import oxipng
except ImportError:
    oxipng = None

PAD = 40           # --check で切り位置の上下に見せる px
DIFF = 24          # 隣の画素と「違う色」と見なす差
NOISE = 2          # 1 走査線に許す色の切り替わり回数
RULE = 0.5         # この割合以上の走査線で切り替わる列は縦罫線とみなして無視
MINRUN = 5         # 切ってよい隙間の最小の厚み (行間は 9〜11px 前後ある)


def clean_runs(im):
    """文字が乗っていない走査線の連なりを [(開始, 長さ), ...] で返す"""
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    t = np.abs(np.diff(a, axis=1)).max(axis=2) > DIFF        # (H, W-1) 横方向の色の変化
    t = t[:, t.mean(axis=0) <= RULE]                         # ガターの罫線などを落とす
    clean, runs, y = t.sum(axis=1) <= NOISE, [], 0
    while y < len(clean):
        if clean[y]:
            s = y
            while y < len(clean) and clean[y]:
                y += 1
            runs.append((s, y - s))
        else:
            y += 1
    return runs


def cut_points(h, runs, max_h, win):
    """高さ h を max_h 以下に割る切り位置。残りを均等に割りながら 1 枚ずつ確定する"""
    # 厚みのある隙間を優先する。1〜2px の隙間は中央で切っても真上と真下に文字が来るため、
    # 行高の丸めで 1px でもずれると文字を裂いたように見える
    wide = np.array([s + n // 2 for s, n in runs if n >= MINRUN])
    allc = np.array([s + n // 2 for s, n in runs])
    cuts, y, left = [], 0, math.ceil(h / max_h)
    while left > 1:
        target = y + (h - y) / left
        lo = max(y + 1, h - (left - 1) * max_h, int(target) - win)   # ここを下回ると残りが割れない
        hi = min(y + max_h, int(target) + win)                       # ここを超えるとこの 1 枚が溢れる
        for cand, note in ((wide, ""), (allc, "  注意: %dpx 未満の隙間で切った" % MINRUN)):
            c = cand[(cand >= lo) & (cand <= hi)] if len(cand) else cand
            if len(c):
                cut = int(c[np.argmin(np.abs(c - target))])
                if note:
                    print(note + " (y=%d)" % cut)
                break
        else:
            cut = int(min(max(target, lo), hi))
            print("  警告: %d 付近に文字の無い走査線が無く %d で断ち切った" % (target, cut))
        cuts.append(cut)
        y, left = cut, left - 1
    return cuts


def split(path, out_dir, max_h, win, dry):
    im = Image.open(path)
    name, ext = os.path.splitext(os.path.basename(path))
    if im.height <= max_h:
        print("%-52s %dx%d  無変換" % (name[:52], im.width, im.height))
        return [path], []

    cuts = cut_points(im.height, clean_runs(im), max_h, win)
    edges = [0] + cuts + [im.height]
    hs = [b - a for a, b in zip(edges, edges[1:])]
    print("%-52s %dx%d  -> %d 枚 %s  (目標 %d / ずれ %s)" % (
        name[:52], im.width, im.height, len(hs), hs, im.height / len(hs),
        [c - round(im.height * (i + 1) / len(hs)) for i, c in enumerate(cuts)]))
    over = [x for x in hs if x > max_h]
    if over:
        sys.exit("分割後も %s が %dpx を超えている" % (over, max_h))

    out = []
    for i, (a, b) in enumerate(zip(edges, edges[1:])):
        p = os.path.join(out_dir or os.path.dirname(path), "%s-%d%s" % (name, i + 1, ext))
        if not dry:
            piece = im.crop((0, a, im.width, b))       # P モードなら crop がパレットを引き継ぐ
            assert piece.mode == im.mode, (piece.mode, im.mode)
            piece.save(p, optimize=True)
            if oxipng:
                oxipng.optimize(p, level=4)
        out.append(p)
        print("  %-50s %dx%d  %s" % (os.path.basename(p), im.width, b - a,
                                     "(dry-run)" if dry else "%d KB" % (os.path.getsize(p) // 1024)))
    return out, [(name, i + 1, len(hs), c) for i, c in enumerate(cuts)]


def contact(cuts, out):
    """切り位置の前後 PAD px を、赤い線と見出しを挟んで縦に並べた 1 枚"""
    from PIL import ImageDraw
    src = {}
    rows = []
    for path, name, i, n, y in cuts:
        im = src.setdefault(path, Image.open(path).convert("RGB"))
        rows.append(("%s  cut %d/%d  y=%d" % (name, i, n, y),
                     im.crop((0, max(0, y - PAD), im.width, min(im.height, y + PAD)))))
    w = max(r[1].width for r in rows)
    lab = 18
    canvas = Image.new("RGB", (w, sum(r[1].height + lab + 3 for r in rows)), (255, 255, 255))
    d = ImageDraw.Draw(canvas)
    y = 0
    for text, strip in rows:
        d.text((6, y + 3), text, fill=(0, 0, 0))
        y += lab
        canvas.paste(strip, (0, y))
        # ここで切った。暗い背景でも見えるように太く、かつ文字を隠さない色で引く
        d.line([(0, y + PAD - 1), (w, y + PAD - 1)], fill=(255, 0, 255), width=3)
        y += strip.height + 3
    canvas.save(out)
    print("\n切り位置の確認用: %s  %dx%d (%d か所) — **目視すること**"
          % (out, canvas.width, canvas.height, len(rows)))


def main():
    pos, opt = [], {"max": 2048, "win": 120, "out": None, "dry-run": False, "check": None}
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--dry-run":
            opt["dry-run"] = True
        elif a in ("--out", "--check"):
            opt[a[2:]] = next(it)
        elif a.startswith("--"):
            opt[a[2:]] = int(next(it))
        else:
            pos.append(a)
    if not pos:
        sys.exit(__doc__)
    if opt["out"] and not os.path.isdir(opt["out"]):
        os.makedirs(opt["out"])

    lines, cuts = [], []
    for p in pos:
        qs, cs = split(p, opt["out"], opt["max"], opt["win"], opt["dry-run"])
        for i, q in enumerate(qs):
            lines.append(("<ラベル>" if i == 0 else "", q))   # ラベルは 1 枚目だけ
        cuts += [(p,) + c for c in cs]
    if opt["check"] and cuts:
        contact(cuts, opt["check"])   # ラベルは 1 枚目だけ
    print("\n=== マニフェスト用 (ラベル ⇥ 画像パス / 継ぎはラベル空) ===")
    for label, q in lines:
        print("%s\t%s" % (label, q))


if __name__ == "__main__":
    main()
