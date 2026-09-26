"""撮影した生スクショを crop して 1 ファイル 1 枚に連結する。

    python stitch.py <spec.json> <生スクショのディレクトリ> <出力先ディレクトリ> <prefix> <actual>

* 生スクショは `00.jpg` `01.jpg` ... と spec の順で並んでいること
* `<actual>` は実際の `scrollTop` の一覧。JSON 文字列でもファイルパスでもよい。
  **最終ページは末尾で clamp されて want とずれる**ので、指定値ではなく読み返した値を渡す
* 出力は `<prefix><NN>-<name>.png`

crop の左右と上端の扱いは spec JSON の `env` にある (mkspec.py の docstring を参照)。
"""
import json, os, sys
from PIL import Image


def load_actual(a):
    return json.loads(open(a).read() if os.path.exists(a) else a)


def main():
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    spec_path, raw_dir, out_dir, prefix = sys.argv[1:5]
    D = json.load(open(spec_path))
    spec, names, env = D["spec"], D["names"], D["env"]
    actual = load_actual(sys.argv[5])
    if len(actual) != len(spec):
        sys.exit("actual の長さが spec と違う: %d / %d" % (len(actual), len(spec)))

    parts = {}
    for i, s in enumerate(spec):
        dy = s["want"] - actual[i]
        y0 = round((env["top"] + dy) * env["k"])
        y1 = round((env["top"] + dy + s["seg"]) * env["k"])
        path = os.path.join(raw_dir, "%02d.jpg" % i)
        im = Image.open(path).convert("RGB")
        if y1 > im.height:
            sys.exit("%s の切り出し範囲がスクショの外 (y1=%d > %d)。actual がずれている"
                     % (path, y1, im.height))
        parts.setdefault(s["k"], []).append(im.crop((env["x0"], y0, env["x1"], y1)))

    os.makedirs(out_dir, exist_ok=True)
    for k, ims in sorted(parts.items()):
        w, h = max(i.width for i in ims), sum(i.height for i in ims)
        out, y = Image.new("RGB", (w, h)), 0
        for im in ims:
            out.paste(im, (0, y))
            y += im.height
        name = "%s%02d-%s.png" % (prefix, k, names[k])
        out.save(os.path.join(out_dir, name))
        print("%-46s %4dx%-6d ページ %d" % (name, w, h, len(ims)))


if __name__ == "__main__":
    main()
