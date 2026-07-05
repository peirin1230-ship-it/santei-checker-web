"""webstatic/vendor/ の再生成: npmから取得し、DuckDB-WASMワーカーへパッチを適用する。

使い方:
    python3 webstatic/vendor/fetch_and_patch.py

構成の経緯(2026-07 検証):
- duckdb-wasm は 1.30.0 の mvp バンドルに固定する。
  - eh バンドルは Chromium 141 で "null function or function signature mismatch"
    でトラップする(1.29/1.30/1.33-dev いずれも)
  - 1.31以降は parquet が実行時取得の動的拡張になり、外部接続が制限された
    院内ネットワークで動かない(本ツールはCSV同梱なので機能上は不要だが、
    バージョンを上げる際は再検証すること)
- mvp ワーカーには上流のビルド不具合があり、Emscripten の例外処理グルーが参照する
  wasm export の遅延束縛(_setThrew, ___cxa_can_catch 等18個)が欠落している。
  そのままではクエリエラー時に "ReferenceError: _setThrew is not defined" で
  エラーメッセージが返せない(1.29〜1.32のmvpワーカーすべてで欠落を確認)。
  本スクリプトが var 連鎖に遅延束縛を挿入して修復する。
"""

from __future__ import annotations

import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

DUCKDB_WASM_VERSION = "1.30.0"
JSZIP_VERSION = "3.10.1"
VENDOR = Path(__file__).resolve().parent

# ワーカーJSが参照するのに定義が欠けている wasm export(JS側 _name ↔ export name)
MISSING_BINDINGS = [
    "___cxa_can_catch", "___cxa_decrement_exception_refcount", "___cxa_demangle",
    "___cxa_get_exception_ptr", "___cxa_increment_exception_refcount",
    "___errno_location", "___getTypeName", "___get_exception_message",
    "_fileno", "_htonl", "_htons", "_memcmp", "_memcpy", "_ntohs",
    "_strerror", "_times", "_write",
]


def fetch(url: str) -> bytes:
    print(f"取得: {url}")
    with urllib.request.urlopen(url) as r:
        return r.read()


def patch_worker(src: str) -> str:
    """mvpワーカーの var 連鎖に、欠落している遅延束縛を挿入する。"""
    anchor = ",_malloc=Module._malloc=e=>"
    if src.count(anchor) != 1:
        raise RuntimeError(
            f"パッチ位置が特定できません(anchor {src.count(anchor)}箇所)。"
            "duckdb-wasmのバージョン変更時はこのスクリプトの再検証が必要です")
    bindings = ",_setThrew=(e,t)=>(_setThrew=wasmExports.setThrew)(e,t)," + "".join(
        f"{n}=(...a)=>({n}=wasmExports.{n[1:]})(...a)," for n in MISSING_BINDINGS)
    return src.replace(anchor, bindings + anchor.lstrip(","))


def main() -> int:
    tgz = fetch("https://registry.npmjs.org/@duckdb/duckdb-wasm/"
                f"-/duckdb-wasm-{DUCKDB_WASM_VERSION}.tgz")
    wanted = {
        "package/dist/duckdb-browser.mjs": "duckdb-browser.mjs",
        "package/dist/duckdb-browser-mvp.worker.js": "duckdb-browser-mvp.worker.js",
        "package/dist/duckdb-mvp.wasm": "duckdb-mvp.wasm",
    }
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        for member, out_name in wanted.items():
            data = tf.extractfile(member).read()
            if out_name == "duckdb-browser-mvp.worker.js":
                data = patch_worker(data.decode("utf-8")).encode("utf-8")
                print(f"  パッチ適用: 遅延束縛 {len(MISSING_BINDINGS) + 1} 個")
            (VENDOR / out_name).write_bytes(data)
            digest = hashlib.md5(data).hexdigest()
            print(f"  {out_name}: {len(data):,} bytes md5={digest}")

    jszip = fetch("https://registry.npmjs.org/jszip/-/jszip-"
                  f"{JSZIP_VERSION}.tgz")
    with tarfile.open(fileobj=io.BytesIO(jszip), mode="r:gz") as tf:
        data = tf.extractfile("package/dist/jszip.min.js").read()
        (VENDOR / "jszip.min.js").write_bytes(data)
        print(f"  jszip.min.js: {len(data):,} bytes md5={hashlib.md5(data).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
