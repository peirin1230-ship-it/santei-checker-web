# santei-checker-web

診療行為の算定可否・併算定可否を一次判定(スクリーニング)するツールの
**静的Web版(プログラムのみ)** です。GitHub Pages で配信されます。

> 本ツールの出力は一次判定であり、最終判断は告示・留意事項通知・疑義解釈の
> 原文および審査支払機関・審査委員会の医学的判断によります。

## このリポジトリにデータは含まれません

- ここにあるのは判定エンジン(ブラウザ内で動く DuckDB-WASM)と画面だけです
- 判定に使うデータ(医科電子点数表・各種マスター等から生成した
  `santei_pages_data.zip`)は**院内配布**であり、本リポジトリ・公開サイトには
  含まれません。zipの生成元は非公開リポジトリで管理しています
- ページを開いて最初に zip を選択すると使えるようになります。データは
  ブラウザ内でのみ処理され、**外部には送信されません**(2回目以降は
  ブラウザに保存されたデータを自動で読み込みます)

## 構成

```text
webstatic/
├── index.html        # 画面
├── app.src.mjs       # 判定・検索・条文参照ロジック(ソース)
├── app.js            # 配信用バンドル(build.sh で生成)
├── build.sh          # esbuild によるバンドル手順
└── vendor/           # 同梱ライブラリ(下記ライセンス)
    └── fetch_and_patch.py  # vendor の再取得＋パッチ手順(経緯コメント参照)
```

デプロイは `.github/workflows/pages.yml`(main への push で自動)。
公開サイトに公的データが混入しないことをワークフロー内でも検査しています。

## 同梱ライブラリのライセンス

- [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm) 1.30.0 — MIT License
  (`webstatic/vendor/LICENSE-duckdb-wasm.txt`)。例外処理グルーの欠落を修復する
  パッチを適用しています(内容は `fetch_and_patch.py`)
- [JSZip](https://github.com/Stuk/jszip) 3.10.1 — MIT License
  (`webstatic/vendor/LICENSE-jszip.md`)
