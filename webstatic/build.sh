#!/usr/bin/env bash
# webstatic/app.js のビルド(app.src.mjs を esbuild でバンドル)。
#
# vendor/duckdb-browser.mjs が bare import する 'apache-arrow' を
# ローカル npm から解決するため --alias が必要。
# vendor/ 自体の再生成は fetch_and_patch.py(パッチ内容もそちらを参照)。
set -euo pipefail
cd "$(dirname "$0")/.."

npm install --no-save --no-audit --no-fund esbuild apache-arrow@17.0.0
npx esbuild webstatic/app.src.mjs --bundle --format=esm \
  --alias:apache-arrow=./node_modules/apache-arrow \
  --outfile=webstatic/app.js
echo "OK: webstatic/app.js"
