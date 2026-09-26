# docs — プロジェクト関連ドキュメント

> 上限 800 トークン (警告 600)。超えたら圧縮する。
> 計測: `./.claude/skills/reload-project/count_tokens.sh docs/README.md`

後から参照するドキュメントの置き場。一般資料は**公式性で3つに分け**、
機械可読なGherkin手順書は `feature/` に分ける。

```
docs/
├── feature/      # Gherkin の仕様・手動テスト手順
├── official/     # 正式に合意・承認されたもの
├── unofficial/   # 共有はするが未確定のもの
└── personal/     # 自分だけが使うもの
```

## 分類

| ディレクトリ | 置くもの |
| --- | --- |
| `feature/` | Gherkinの `.feature`。現在仕様と `archived/` を管理 |
| `official/` | 要件定義、仕様書、契約、規約、確定した設計書 |
| `unofficial/` | 議事メモ、調査結果、設計の下書き、検討中の案 |
| `personal/` | 作業メモ、手順の覚書、チートシート |

迷ったら **「他人がこれを根拠に判断してよいか」** で切る。
根拠にしてよい → `official/`。共有はするが根拠にできない → `unofficial/`。
他人が読む想定がない → `personal/`。

合意を経て確定したら `git mv` で `unofficial/` から `official/` に移す。
Gherkin手順書は公式性によらず `feature/` に置き、詳細は [feature/README.md](feature/README.md) に従う。

## 配置と命名

各分類の下は案件ごとに切り、名前は `jobs/<案件名>/` と揃える。
案件に紐づかないものは `common/`。`personal/` は直下でよい。

```sh
mkdir -p docs/official/acme-site
```

ファイル名は英小文字とハイフン。日付が意味を持つものは
`2026-08-07-kickoff-memo.md` のように `YYYY-MM-DD-` を先頭に付ける。

## logs/ との使い分け

`logs/` は agent のセッション記録、`docs/` は継続的に参照するドキュメント。
調査結果はセッションの `outputs/` に出し、以後も参照するものだけ `docs/` に移す。

## 運用

* 空ディレクトリには `.gitkeep` を置く ([README.md](../README.md) の規約)。
* `docs/personal/` を追跡しない場合は `.gitignore` に `docs/personal/` を追記する。
