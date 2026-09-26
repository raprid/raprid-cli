"""split_tall.py が**書き出した断片**の接合面に文字が乗っていないかを独立に確かめる。

    python verify_cuts.py <ディレクトリ | 画像...>

split_tall.py は「文字の無い走査線で切った」と主張するが、その主張は切る前の画像に対する
判定でしかない。**ここでは保存後の PNG を読み直し**、隣り合う断片の接合面 (上の断片の
最終数行と下の断片の先頭数行) に文字が乗っていないかを見る。

実際にこの検査で 2 か所の切り損じを見つけた (`MINRUN` を入れる前は、目標の高さの近くに
1〜3px の隙間があるとそこを選んでしまい、真上と真下に文字が来ていた)。
**アルゴリズムの自己申告ではなく、出力を見て判定する検査をひとつ残しておくこと。**

`<元の名前>-1.png` を起点に `-2` `-3` … を番号順に組にする。断片が 1 枚だけの組
(分割していないファイル) は接合面が無いので何も見ない。
文字を裂いた疑いが 1 か所でもあれば終了コード 1 を返す。
"""
import glob, os, re, sys
from PIL import Image
import numpy as np

DIFF, NOISE, RULE = 24, 2, 0.5   # split_tall.py と同じ (走査線の判定基準は共有する)
EDGE = 3                         # 接合面の上下で見る走査線の数


def tr_rows(im):
    """走査線ごとの「横方向の色の切り替わり回数」。縦罫線の列は落とす"""
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    t = np.abs(np.diff(a, axis=1)).max(axis=2) > DIFF
    return t[:, t.mean(axis=0) <= RULE].sum(axis=1)


def groups(args):
    """`-1.png` を起点に断片の組を集める。{元の名前: [パス, ...]}"""
    paths = []
    for a in args or ["."]:
        paths += sorted(glob.glob(os.path.join(a, "**", "*-1.png"), recursive=True)) \
            if os.path.isdir(a) else [a]
    out = {}
    for p in sorted(set(paths)):
        m = re.match(r"(.*)-(\d+)\.png$", p)
        if not m:
            continue
        stem = m.group(1)
        if stem in out:
            continue
        ps = [(int(n.group(2)), n.group(0))
              for n in (re.match(r"(.*)-(\d+)\.png$", q)
                        for q in glob.glob(glob.escape(stem) + "-*.png")) if n]
        out[stem] = [q for _, q in sorted(ps)]
    return out


bad = tot = 0
for stem, ps in sorted(groups(sys.argv[1:]).items()):
    for i, (a, b) in enumerate(zip(ps, ps[1:])):
        ta, tb = tr_rows(Image.open(a)), tr_rows(Image.open(b))
        up, dn = ta[-EDGE:].max(), tb[:EDGE].max()
        ok = up <= NOISE and dn <= NOISE
        tot += 1
        bad += not ok
        print("%-46s %d/%d 継ぎ目  上 %2d / 下 %2d  %s"
              % (os.path.basename(stem)[:46], i + 1, len(ps), up, dn,
                 "○" if ok else "× 文字が乗っている"))

print("\n接合面 %d か所 / 文字を裂いた疑い %d か所" % (tot, bad))
if bad:
    print("**--check の画像を目視し、切り位置を直すこと。**")
sys.exit(1 if bad else 0)
