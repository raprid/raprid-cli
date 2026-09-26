"""連結画像の繋ぎ目付近を切り出して 1 枚に並べる (目視検証用)。

    python seams.py <spec.json> <連結画像のディレクトリ> <prefix> <出力.png> <actual> [--pad 44]

各繋ぎ目の上下 `--pad` px を取り、境界に赤い横線を引いて縦に並べる。
左上の橙色の数字は `<ファイル番号>/<繋ぎ目番号>`。

**出力は Read tool で必ず目視する。行番号が飛んでいないことを全ての繋ぎ目で確認する。**
ここは自動化しない — 1 行の欠落も重複も、資料の読み手には検証できない。
"""
import collections, json, os, sys
from PIL import Image, ImageDraw


def main():
    argv, pad = [], 44
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--pad":
            pad = int(next(it))
        else:
            argv.append(a)
    if len(argv) != 5:
        sys.exit(__doc__)
    spec_path, out_dir, prefix, dst, actual_arg = argv

    D = json.load(open(spec_path))
    env = D["env"]
    actual = json.loads(open(actual_arg).read() if os.path.exists(actual_arg) else actual_arg)

    # ファイルごとに各ページの crop 高さを再計算して累積 y を出す
    heights = collections.defaultdict(list)
    for i, s in enumerate(D["spec"]):
        dy = s["want"] - actual[i]
        heights[s["k"]].append(round((env["top"] + dy + s["seg"]) * env["k"])
                               - round((env["top"] + dy) * env["k"]))

    strips = []
    for k, hs in sorted(heights.items()):
        if len(hs) < 2:
            continue
        im = Image.open(os.path.join(out_dir, "%s%02d-%s.png" % (prefix, k, D["names"][k])))
        y = 0
        for j, h in enumerate(hs[:-1]):
            y += h
            s = im.crop((0, max(0, y - pad), im.width, min(im.height, y + pad))).copy()
            d = ImageDraw.Draw(s)
            d.line([(0, pad), (s.width, pad)], fill=(255, 0, 0), width=1)
            d.text((6, 2), "%d/%d" % (k, j), fill=(255, 128, 0))
            strips.append(s)

    if not strips:
        return print("繋ぎ目なし (全ファイルが 1 ページに収まっている)")
    w = max(s.width for s in strips)
    out, y = Image.new("RGB", (w, sum(s.height + 6 for s in strips)), (255, 255, 0)), 0
    for s in strips:
        out.paste(s, (0, y))
        y += s.height + 6
    out.save(dst)
    print("%s %s 繋ぎ目 %d 箇所 -> Read tool で目視すること" % (dst, out.size, len(strips)))


if __name__ == "__main__":
    main()
