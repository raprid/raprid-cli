"""撮影計画 (spec JSON) を作る。何ページに分けてどの scrollTop で撮るかを決める。

    python mkspec.py <出力先.json> --sizes '[820, 3100, ...]' \
        --names '["api-00-admin-item.controller.ts", ...]' \
        --lines '[24, 118, ...]' \
        [--page 780] [--k 26/27] [--top 48] [--x0 8] [--x1 1434]

* `--sizes` は `DynamicScroller.vscrollData.sizes` の実測値をファイルの並び順に。実高さは `size - 16`
* `--names` は出力ファイル名にするラベル、`--lines` は行数 (繋ぎ目の目視で使う)
* `--page` は 1 ページの送り幅 (CSS px)。ウィンドウの高さより小さくとる

**`--k` 以降は環境依存**なので撮影のたびに実測して渡す。spec JSON の `env` に入り、
stitch.py と seams.py はそこから読む。ウィンドウサイズを変えると全部変わる。

| キー | 意味 | 2026-01-15 の実測 (1512x861 / dpr 2 / スクショ 1456x829) |
| --- | --- | --- |
| `k` | スクショ px / CSS px | `26/27` |
| `top` | スクローラーの上端オフセット (CSS px) | `48` |
| `x0` / `x1` | crop の左右 (スクショ px、右は排他) | `8` / `1434` |

**x0 / x1 を CSS 座標から換算してはいけない。** 右端が排他なので枠線が 1px 落ち、
左だけ枠がある画像になって「右端で見切れている」と読まれる。スクショの画素を読んで決める。
"""
import json, math, sys


def ratio(s):
    """`26/27` も `0.963` も受ける。"""
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b)
    return float(s)


def main():
    argv, opt = [], {"page": 780, "k": "26/27", "top": 48, "x0": 8, "x1": 1434}
    it = iter(sys.argv[1:])
    for a in it:
        if a.startswith("--"):
            opt[a[2:]] = next(it)
        else:
            argv.append(a)
    if len(argv) != 1 or not all(k in opt for k in ("sizes", "names", "lines")):
        sys.exit(__doc__)

    sizes = json.loads(opt["sizes"])
    names = json.loads(opt["names"])
    lines = json.loads(opt["lines"])
    if not len(sizes) == len(names) == len(lines):
        sys.exit("sizes / names / lines の長さが違う: %d / %d / %d"
                 % (len(sizes), len(names), len(lines)))
    page = int(opt["page"])
    env = {"k": ratio(str(opt["k"])), "top": int(opt["top"]),
           "x0": int(opt["x0"]), "x1": int(opt["x1"])}

    spec, top = [], 0
    for k, sz in enumerate(sizes):
        h = sz - 16                      # 実高さ。size にはファイル間の余白 16px が入っている
        n = math.ceil(h / page)
        for q in range(n):
            off = q * page
            spec.append({"k": k, "p": q, "n": n, "want": top + off,
                         "seg": round(min(page, h - off)), "name": names[k]})
        top += sz

    json.dump({"page": page, "env": env, "total": top, "names": names,
               "lines": lines, "sizes": sizes, "spec": spec},
              open(argv[0], "w"), ensure_ascii=False, indent=1)
    print("%s: %d ファイル / %d ページ / 全長 %dpx" % (argv[0], len(sizes), len(spec), top))
    print("env: %s" % env)
    for k, sz in enumerate(sizes):
        n = sum(1 for s in spec if s["k"] == k)
        print("  %2d %-46s size=%-6d %d ページ" % (k, names[k], sz, n))


if __name__ == "__main__":
    main()
