/* 算定チェッカー静的版: ブラウザ内エンジン(DuckDB-WASM)。
 * 判定ロジックは src/santei/engine/*.py の移植。SQLは同一のものを使い、
 * 結果がサーバー版と一致することをE2Eテスト(tests/test_static_e2e.py)で担保する。
 * データは利用者が読み込む zip(CSV群)内のみ。外部送信はしない。
 * ビルド: webstatic/build.sh(esbuildでバンドルして app.js を生成) */
import * as duckdb from "./vendor/duckdb-browser.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ---------- DuckDB 初期化・データ読み込み ---------- */
let conn = null;
let ckEdition = null;

async function initDb(zipBuf) {
  $("loading").textContent = "データベースを初期化中…";
  // URLは絶対化する(相対のままだとWorker内で vendor/vendor/… に解決され404になる)
  const workerUrl = new URL("./vendor/duckdb-browser-mvp.worker.js", location.href).href;
  const wasmUrl = new URL("./vendor/duckdb-mvp.wasm", location.href).href;
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(
    new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(wasmUrl);
  conn = await db.connect();
  const zip = await JSZip.loadAsync(zipBuf);
  const names = Object.keys(zip.files).filter((n) => n.endsWith(".csv"));
  for (const n of names) {
    const buf = await zip.files[n].async("uint8array");
    await db.registerFileBuffer(n, buf);
    const table = n.replace(/\.csv$/, "");
    // CSVはクエリごとの再パースを避けるため一度だけテーブル化する。
    // all_varchar でコードの先頭ゼロを保持(CLAUDE.md 規約)
    await conn.query(
      `CREATE TABLE "${table}" AS SELECT * FROM read_csv('${n}', header=true, all_varchar=true)`);
    await db.dropFile(n);
  }
  const manifest = zip.files["manifest.json"]
    ? JSON.parse(await zip.files["manifest.json"].async("string")) : {};
  ckEdition = (await rows(
    "SELECT max(edition) AS e FROM checkmaster_iy_tekio"))[0]?.e ?? null;
  $("dataInfo").textContent =
    `(データ生成日: ${manifest.generated ?? "不明"} / チェックマスタ: ${ckEdition ?? "なし"})`;
  $("setup").style.display = "none";
  $("app").style.display = "block";
}

async function rows(sql, params = []) {
  let res;
  if (params.length) {
    const stmt = await conn.prepare(sql);
    res = await stmt.query(...params);
    await stmt.close();
  } else {
    res = await conn.query(sql);
  }
  return res.toArray().map((r) => {
    const o = r.toJSON();
    for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
    return o;
  });
}

/* IndexedDB にzipを保存して次回以降は自動読み込み */
function idb() {
  return new Promise((ok, ng) => {
    const req = indexedDB.open("santei-static", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ng(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((ok) => {
    const r = db.transaction("files").objectStore("files").get(key);
    r.onsuccess = () => ok(r.result); r.onerror = () => ok(null);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((ok, ng) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(val, key);
    tx.oncomplete = () => ok();
    tx.onerror = tx.onabort =
      () => ng(tx.error ?? new Error("IndexedDBへの書き込みに失敗"));
  });
}
async function idbDel(key) {
  const db = await idb();
  return new Promise((ok) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").delete(key);
    tx.oncomplete = () => ok();
  });
}

/* ---------- config.py の移植 ---------- */
const EDITION_STARTS = {
  shinryokoi: [["r06", "2024-06"], ["r08", "2026-06"]],
  iyakuhin: [["r06", "2024-04"], ["r07", "2025-04"], ["r08", "2026-04"]],
};
const NOT_LISTED = "テーブル上の背反・包括の収載なし(未収載パターンの可能性あり)";
const UNLISTED_RULES_NOTE =
  "※電子点数表には意図的に収載されていないルールがあります" +
  "(3項目以上実施時の「主たるもの2つに限り算定」等の多対多ルール、" +
  "傷病名・部位等の要件が限定された背反、2項目の算定により別の1項目が" +
  "背反となるケース、複数要件の背反、被包括項目が明記されていない包括 等)。" +
  "テーブルに該当がないことは併算定可を意味しません。";

function editionFor(ym, series = "shinryokoi") {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`診療年月はYYYY-MM形式: ${ym}`);
  let ed = null;
  for (const [e, start] of EDITION_STARTS[series]) if (ym >= start) ed = e;
  if (!ed) throw new Error(`${ym} は収載版の適用開始より前です`);
  return ed;
}
function classifyCode(c) {
  if (/^1\d{8}$/.test(c)) return "診療行為";
  if (/^6\d{8}$/.test(c)) return "医薬品";
  if (/^7\d{8}$/.test(c)) return "特定器材";
  if (/^8\d{8}$/.test(c)) return "コメント";
  if (/^\d{7}$/.test(c)) return "傷病名";
  if (/^\d{4}$/.test(c)) return "修飾語";
  return "不明";
}
const FW = "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ－";
const HW = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-";
const toHw = (s) => [...s].map((ch) => {
  const i = FW.indexOf(ch); return i >= 0 ? HW[i] : ch;
}).join("");

/* checker.py の定数 */
const HAIHAN_TABLES = [["haihan_day", "1日につき"], ["haihan_month", "同一月内"],
  ["haihan_simultaneous", "同時"], ["haihan_week", "1週間につき"]];
const HAIHAN_KUBUN = {"1": "コード①側を算定", "2": "コード②側を算定", "3": "いずれか一方を算定"};
const HOKATSU_TANI = {"01": "1日につき", "1": "1日につき", "02": "同一月内", "2": "同一月内",
  "03": "同時", "3": "同時", "05": "手術前1週間", "5": "手術前1週間",
  "06": "1手術につき", "6": "1手術につき"};
const NYUGAI = {"0": "入院・入院外とも記録可", "1": "入院レセプトに限り記録可能",
  "2": "入院外レセプトに限り記録可能"};
const KUBUN_EXPR = `coalesce(nullif(tensuhyo_kubun_bango, ''),
  code_hyoyo_bango_alphabet || code_hyoyo_bango_kubun_bango ||
  CASE WHEN code_hyoyo_bango_edaban NOT IN ('', '00')
       THEN '-' || CAST(CAST(code_hyoyo_bango_edaban AS INT) AS VARCHAR) ELSE '' END)`;

/* ---------- 条文・関連情報(knowledge.py の移植) ---------- */
async function resolveRef(ref, source) {
  ref = ref.trim();
  let hit = await rows(
    "SELECT filename FROM doc_ref WHERE source=? AND ref=?", [source, ref]);
  if (hit.length) return hit[0].filename;
  const m = ref.match(/^([A-Z])(\d{3})(.*)$/);
  if (m && m[3] && !m[3].startsWith("-")) {  // 連結表記のみbaseへ。枝番は縮退しない
    hit = await rows("SELECT filename FROM doc_ref WHERE source=? AND ref=?",
      [source, m[1] + m[2]]);
    if (hit.length) return hit[0].filename;
  }
  return null;
}
function nameVariants(name) {
  name = (name ?? "").trim();
  const out = [];
  if (name.length >= 3) out.push(name);
  const base = name.split(/[（(　 ]/)[0];
  if (base.length >= 3 && base !== name) out.push(base);
  return out;
}
const likeEsc = (s) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

/* ---------- 判定(checker.py + report.py の移植) ---------- */
function monthBounds(ym) {
  const base = ym.replace("-", "");
  return [base + "01", base + "31"];
}

async function lookupCode(code, edition, ym, monthStart) {
  const kind = classifyCode(code);
  const info = {code, kind, found: false, name: null, kubun: null, expired: false,
    nyugai: null, tsusoku: null, kagen: null, jogen: null, shisetsu: [], haishi: null};
  if (kind === "医薬品") {
    const ed = editionFor(ym, "iyakuhin");
    const r = await rows(
      "SELECT kanji_meisho FROM master_iyakuhin WHERE edition=? AND iyakuhin_code=?",
      [ed, code]);
    if (r.length) { info.found = true; info.name = r[0].kanji_meisho; }
    return info;
  }
  if (kind === "傷病名") {
    const r = await rows(
      "SELECT shobyomei_kihon_meisho AS n FROM master_shobyomei WHERE edition=? AND shobyomei_code=?",
      [edition, code]);
    if (r.length) { info.found = true; info.name = r[0].n; }
    return info;
  }
  if (kind !== "診療行為") return info;
  const r = await rows(`
    SELECT shoryaku_kanji_meisho, ${KUBUN_EXPR} AS kubun, nyugai_tekiyo_kubun,
           tsusoku_nenrei, kagen_nenrei, jogen_nenrei, haishi_ymd,
           shisetsu_kijun_code_1, shisetsu_kijun_code_2, shisetsu_kijun_code_3,
           shisetsu_kijun_code_4, shisetsu_kijun_code_5, shisetsu_kijun_code_6,
           shisetsu_kijun_code_7, shisetsu_kijun_code_8, shisetsu_kijun_code_9,
           shisetsu_kijun_code_10
    FROM master_shinryokoi WHERE edition=? AND shinryokoi_code=?`, [edition, code]);
  if (r.length) {
    const x = r[0];
    Object.assign(info, {found: true, name: x.shoryaku_kanji_meisho, kubun: x.kubun,
      nyugai: x.nyugai_tekiyo_kubun, tsusoku: x.tsusoku_nenrei,
      kagen: x.kagen_nenrei, jogen: x.jogen_nenrei, haishi: x.haishi_ymd,
      expired: !!x.haishi_ymd && x.haishi_ymd < monthStart});
    for (let i = 1; i <= 10; i++) {
      const v = x[`shisetsu_kijun_code_${i}`];
      if (v && v !== "0") info.shisetsu.push(v);
    }
  }
  return info;
}

async function runCheck(codesInput, ym, ryoMap, nissuMap) {
  const edition = editionFor(ym, "shinryokoi");
  const [ms, me] = monthBounds(ym);
  const codes = [...new Set(codesInput)];
  const infos = {};
  for (const c of codes) infos[c] = await lookupCode(c, edition, ym, ms);
  const shinryokoi = codes.filter((c) => infos[c].kind === "診療行為");
  const drugs = codes.filter((c) => infos[c].kind === "医薬品");
  const diseases = codes.filter((c) => infos[c].kind === "傷病名");

  const hits = [];           // {kind,title,detail,tokurei,table,evid[],refs[]}
  const notListed = [];
  for (let i = 0; i < shinryokoi.length; i++) {
    for (let j = i + 1; j < shinryokoi.length; j++) {
      const a = shinryokoi[i], b = shinryokoi[j];
      const pair = [];
      for (const [table, joken] of HAIHAN_TABLES) {
        const rws = await rows(`
          SELECT * FROM ${table} WHERE edition=?
            AND ((shinryokoi_code_1=? AND shinryokoi_code_2=?)
              OR (shinryokoi_code_1=? AND shinryokoi_code_2=?))
            AND shinsetsu_ymd<=? AND haishi_ymd>=?`, [edition, a, b, b, a, me, ms]);
        if (!rws.length) continue;
        const kubuns = [...new Set(rws.map((r) => r.haihan_kubun))].sort();
        const tokurei = rws.some((r) => r.tokurei_joken === "1");
        const santei = [...new Set(rws.filter((r) => r.haihan_kubun === "1" || r.haihan_kubun === "2")
          .map((r) => r.haihan_kubun === "1" ? r.shinryokoi_shoryaku_meisho_1 : r.shinryokoi_shoryaku_meisho_2))].sort();
        let detail = kubuns.map((k) => `区分${k}(${HAIHAN_KUBUN[k] ?? "不明"})`).join("・");
        if (santei.length) detail += ` → 算定される側: ${santei.join("、")}`;
        detail += `/特例条件=${tokurei ? "1あり" : "0"}`;
        pair.push({kind: "haihan", title: `[背反] ${joken}テーブル`, detail, tokurei,
          table: `${table}(${edition})`,
          evid: rws.map((r) => `①${r.shinryokoi_code_1} ${r.shinryokoi_shoryaku_meisho_1} × ②${r.shinryokoi_code_2} ${r.shinryokoi_shoryaku_meisho_2} 背反区分=${r.haihan_kubun} 特例条件=${r.tokurei_joken}`),
          refs: [infos[a].kubun, infos[b].kubun].filter(Boolean)});
      }
      for (const [p, q_] of [[a, b], [b, a]]) {  // 包括: p(親)がq_(子)を包括するか
        const hojo = await rows(`
          SELECT hokatsu_tani_1, group_bango_1, hokatsu_tani_2, group_bango_2,
                 hokatsu_tani_3, group_bango_3
          FROM hojo_master WHERE edition=? AND shinryokoi_code=?
            AND shinsetsu_ymd<=? AND haishi_ymd>=?`, [edition, p, me, ms]);
        if (!hojo.length) continue;
        for (const i2 of [1, 2, 3]) {
          const g = hojo[0][`group_bango_${i2}`], tani = hojo[0][`hokatsu_tani_${i2}`];
          if (!g || g === "0") continue;
          const rws = await rows(`
            SELECT * FROM hokatsu WHERE edition=? AND group_bango=? AND shinryokoi_code=?
              AND shinsetsu_ymd<=? AND haishi_ymd>=?`, [edition, g, q_, me, ms]);
          if (!rws.length) continue;
          const tokurei = rws.some((r) => r.tokurei_joken === "1");
          const refs = [infos[p].kubun, infos[q_].kubun].filter(Boolean);
          if (g.length >= 4) {
            let gref = g.slice(0, 4);
            const eda = g.slice(4, 6);
            if (eda.replace(/0/g, "")) gref += `-${parseInt(eda, 10)}`;
            if (!refs.includes(gref)) refs.push(gref);
          }
          hits.push({kind: "hokatsu", title: "[包括] 包括・被包括テーブル",
            detail: `「${infos[q_].name ?? q_}」は「${infos[p].name ?? p}」に包括され算定不可(包括単位: ${HOKATSU_TANI[tani] ?? `単位コード${tani}(不明)`})/特例条件=${tokurei ? "1あり" : "0"}`,
            tokurei, table: `hokatsu(${edition})`,
            evid: rws.map((r) => `グループ${g}(補助マスター: ${p} ${infos[p].name ?? ""} 包括単位=${tani}) に ${r.shinryokoi_code} ${r.shinryokoi_shoryaku_meisho} を収載 特例条件=${r.tokurei_joken}`),
            refs});
          pair.push(hits[hits.length - 1]); hits.pop();
        }
      }
      if (pair.length) hits.push(...pair); else notListed.push([a, b]);
    }
  }
  // 入院基本料
  for (const base of shinryokoi) {
    const h = await rows(`
      SELECT nyuin_kihonryo_shikibetsu AS s FROM hojo_master
      WHERE edition=? AND shinryokoi_code=? AND shinsetsu_ymd<=? AND haishi_ymd>=?`,
      [edition, base, me, ms]);
    if (!h.length || h[0].s === "000") continue;
    const others = shinryokoi.filter((c) => c !== base);
    if (!others.length) continue;
    const kasan = await rows(`
      SELECT * FROM nyuin_kihonryo WHERE edition=? AND group_bango=?
        AND shinryokoi_code IN (${others.map(() => "?").join(",")})
        AND shinsetsu_ymd<=? AND haishi_ymd>=?`, [edition, h[0].s, ...others, me, ms]);
    const by = {};
    for (const r of kasan) (by[r.kasan_shikibetsu] ??= []).push(r);
    for (const sk of Object.keys(by).sort()) {
      const mem = by[sk];
      const names = mem.map((r) => r.shinryokoi_shoryaku_meisho).join("、");
      const detail = mem.length >= 2
        ? `「${infos[base].name ?? base}」(グループ${h[0].s})に対する加算のうち、同一の加算識別${sk}が付いた「${names}」同士は併算定不可`
        : `「${names}」は「${infos[base].name ?? base}」(グループ${h[0].s})の対象加算として収載(加算識別=${sk})`;
      hits.push({kind: "nyuin", title: "[入院基本料] 入院基本料テーブル", detail,
        tokurei: false, table: `nyuin_kihonryo(${edition})`,
        evid: mem.map((r) => `グループ${r.group_bango} ${r.shinryokoi_code} ${r.shinryokoi_shoryaku_meisho} 加算識別=${r.kasan_shikibetsu}`),
        refs: [infos[base].kubun, ...mem.map((r) => infos[r.shinryokoi_code]?.kubun)].filter(Boolean)});
    }
  }
  // 算定回数
  const kaisu = [];
  for (const c of shinryokoi) {
    const rws = await rows(`
      SELECT santei_tani_code, santei_tani_meisho, santei_kaisu, tokurei_joken
      FROM santei_kaisu WHERE edition=? AND shinryokoi_code=?
        AND shinsetsu_ymd<=? AND haishi_ymd>=? ORDER BY santei_tani_code`,
      [edition, c, me, ms]);
    if (rws.length) kaisu.push({code: c, name: infos[c].name ?? c, rows: rws});
  }
  // チェックマスタ(適応・禁忌・併用・投与量・事例)
  const tekiou = [], jireiSummary = [];
  let heiyo = [];
  if (ckEdition) {
    for (const c of codes) {
      if (!["診療行為", "医薬品", "特定器材"].includes(infos[c].kind)) continue;
      const n = (await rows(
        "SELECT count(*) AS n FROM checkmaster_cc_jirei WHERE edition=? AND master_code=? AND henko_kubun NOT IN ('1','9')",
        [ckEdition, c]))[0].n;
      if (n > 0) {
        const samples = await rows(
          "SELECT jirei_code, check_kanten FROM checkmaster_cc_jirei WHERE edition=? AND master_code=? AND henko_kubun NOT IN ('1','9') ORDER BY jirei_code LIMIT 2",
          [ckEdition, c]);
        jireiSummary.push({code: c, name: infos[c].name, count: n, samples});
      }
    }
    for (const drug of drugs) {
      const rep = {code: drug, name: infos[drug].name, kind: "医薬品",
        table: `checkmaster_iy_tekio(${ckEdition})`, listed: false, listedRows: 0,
        matches: [], unmatched: [], mujoken: 0, kinki: [], dose: [], groups: [], manzen: []};
      rep.listedRows = (await rows(
        "SELECT count(*) AS n FROM checkmaster_iy_tekio WHERE edition=? AND iyakuhin_code=? AND henko_kubun NOT IN ('1','9')",
        [ckEdition, drug]))[0].n;
      rep.listed = rep.listedRows > 0;
      if (rep.listed) {
        rep.mujoken = (await rows(
          "SELECT count(*) AS n FROM checkmaster_iy_tekio WHERE edition=? AND iyakuhin_code=? AND shobyomei_code='0000000' AND henko_kubun NOT IN ('1','9')",
          [ckEdition, drug]))[0].n;
        for (const d of diseases) {
          const rws = await rows(`
            SELECT shobyomei_code, seibetsu, nenrei_kagen, nenrei_jogen, check_kubun,
                   saidai_toyoryo, saicho_toyo_nissu, tekigi_zogen_kubun, sansho_hani
            FROM checkmaster_iy_tekio WHERE edition=? AND iyakuhin_code=? AND shobyomei_code=?
              AND henko_kubun NOT IN ('1','9')`, [ckEdition, drug, d]);
          if (rws.length) rep.matches.push({code: d, name: infos[d].name, rows: rws});
          else rep.unmatched.push({code: d, name: infos[d].name});
        }
        if (diseases.length) {
          rep.kinki = await rows(`
            SELECT iyakuhin_code, kinki_shobyomei_code, sansho_hani
            FROM checkmaster_iy_shobyokinki WHERE edition=? AND iyakuhin_code=?
              AND kinki_shobyomei_code IN (${diseases.map(() => "?").join(",")})
              AND henko_kubun NOT IN ('1','9')`, [ckEdition, drug, ...diseases]);
        }
        // 投与量・日数(照合対象: 適応該当行 + 0000000行)
        const mujokenRows = await rows(`
          SELECT saidai_toyoryo, saicho_toyo_nissu, tekigi_zogen_kubun
          FROM checkmaster_iy_tekio WHERE edition=? AND iyakuhin_code=?
            AND shobyomei_code='0000000' AND henko_kubun NOT IN ('1','9')`,
          [ckEdition, drug]);
        const ryo = ryoMap[drug], nissu = nissuMap[drug];
        const doseSrc = [...rep.matches.map((m) => [m.code, m.name, m.rows]),
          [null, null, mujokenRows]];
        for (const [dc, dn, rws] of doseSrc) {
          for (const r of rws) {
            const lr = r.saidai_toyoryo !== "99999.99999" ? r.saidai_toyoryo : null;
            const ln = r.saicho_toyo_nissu !== "999" ? r.saicho_toyo_nissu : null;
            if (lr === null && ln === null) continue;
            rep.dose.push({dc, dn, lr, ln, tekigi: r.tekigi_zogen_kubun === "1",
              ryo, nissu,
              ryoOver: lr !== null && ryo != null ? ryo > parseFloat(lr) : null,
              nissuOver: ln !== null && nissu != null ? nissu > parseFloat(ln) : null});
          }
        }
        rep.groups = await rows(`
          SELECT group_mei, kikaku_chi, seigen_saidai_toyoryo_kikaku, check_taisho_flag
          FROM checkmaster_iy_toyoryou_group WHERE edition=? AND iyakuhin_code=?
            AND henko_kubun NOT IN ('1','9') LIMIT 3`, [ckEdition, drug]);
        rep.manzen = await rows(`
          SELECT group_mei, manzen_toyo_nissu, manzen_reset_nissu, manzen_keisu
          FROM checkmaster_iy_manzen_group WHERE edition=? AND iyakuhin_code=?
            AND henko_kubun NOT IN ('1','9') LIMIT 3`, [ckEdition, drug]);
      }
      tekiou.push(rep);
    }
    if (diseases.length) {
      for (const act of shinryokoi) {
        const rep = {code: act, name: infos[act].name, kind: "診療行為",
          table: `checkmaster_si_shobyo(${ckEdition})`, listed: false, listedRows: 0,
          matches: [], unmatched: [], mujoken: 0, kinki: [], dose: [], groups: [], manzen: []};
        rep.listedRows = (await rows(
          "SELECT count(*) AS n FROM checkmaster_si_shobyo WHERE edition=? AND shinryokoi_code=? AND henko_kubun NOT IN ('1','9')",
          [ckEdition, act]))[0].n;
        rep.listed = rep.listedRows > 0;
        if (rep.listed) {
          for (const d of diseases) {
            const rws = await rows(`
              SELECT shobyomei_code, seibetsu, nenrei_kagen, nenrei_jogen,
                     nyugai_kubun, utagai_byomei, sansho_hani
              FROM checkmaster_si_shobyo WHERE edition=? AND shinryokoi_code=? AND shobyomei_code=?
                AND henko_kubun NOT IN ('1','9')`, [ckEdition, act, d]);
            if (rws.length) rep.matches.push({code: d, name: infos[d].name, rows: rws});
            else rep.unmatched.push({code: d, name: infos[d].name});
          }
        }
        tekiou.push(rep);
      }
    }
    if (drugs.length >= 2) {
      const ph = drugs.map(() => "?").join(",");
      const rws = await rows(`
        SELECT iyakuhin_code_l, iyakuhin_code_r, sansho_hani
        FROM checkmaster_iy_heiyokinki WHERE edition=?
          AND iyakuhin_code_l IN (${ph}) AND iyakuhin_code_r IN (${ph})
          AND henko_kubun NOT IN ('1','9')`, [ckEdition, ...drugs, ...drugs]);
      const seen = new Set();
      heiyo = rws.filter((r) => {
        const k = [r.iyakuhin_code_l, r.iyakuhin_code_r].sort().join("|");
        if (seen.has(k)) return false; seen.add(k); return true;
      });
    }
  }
  // 単一コード入力時は単体プロファイル(相手一覧・逆引き)を付す(checker.build_profileの移植)
  let profile = null;
  if (codes.length === 1 && infos[codes[0]].found
      && (infos[codes[0]].kind === "診療行為" || infos[codes[0]].kind === "医薬品")) {
    profile = await buildProfile(codes[0], infos[codes[0]], edition, ym, ms, me);
  }

  // 選択式コメント必須情報(テーブル投入済みのzipの場合のみ。無ければ表示なし)
  const commentYoken = [];
  try {
    for (const c of shinryokoi) {
      const rws = await rows(`
        SELECT comment_code, comment_bunrei, kisai_jiko, joken
        FROM sentakushiki_comment
        WHERE edition=? AND shinryokoi_code=?
          AND (shinsetsu_ymd IS NULL OR shinsetsu_ymd<=?)
          AND (haishi_ymd IS NULL OR haishi_ymd>=?)
        ORDER BY comment_code`, [edition, c, me, ms]);
      if (rws.length) commentYoken.push({code: c, name: infos[c].name, rows: rws,
        table: `sentakushiki_comment(${edition})`});
    }
  } catch { /* テーブル未投入のzip */ }

  return {ym, edition, codes, infos, hits, notListed, kaisu, tekiou, heiyo,
    jireiSummary, drugs, diseases, shinryokoi, profile, commentYoken};
}

const PROFILE_EXAMPLES = 10;

async function buildProfile(code, info, edition, ym, ms, me) {
  const p = {code, kind: info.kind, haihanAite: [], hokatsuOya: [], hokatsuOyaTotal: 0,
    hokatsuKo: [], tekiouTotal: null, tekiouExamples: [], tekiouTable: null,
    tekiouMujoken: 0, kinkiTotal: 0, kinkiExamples: [], heiyoTotal: 0, heiyoExamples: []};
  if (info.kind === "診療行為") {
    for (const [table, joken] of HAIHAN_TABLES) {
      const agg = await rows(`
        SELECT haihan_kubun, count(*) AS n,
               sum(CASE WHEN tokurei_joken='1' THEN 1 ELSE 0 END) AS t
        FROM ${table} WHERE edition=? AND shinryokoi_code_1=?
          AND shinsetsu_ymd<=? AND haishi_ymd>=? GROUP BY haihan_kubun`,
        [edition, code, me, ms]);
      if (!agg.length) continue;
      const examples = await rows(`
        SELECT shinryokoi_code_2 AS code, shinryokoi_shoryaku_meisho_2 AS name,
               haihan_kubun AS kubun, tokurei_joken AS tokurei
        FROM ${table} WHERE edition=? AND shinryokoi_code_1=?
          AND shinsetsu_ymd<=? AND haishi_ymd>=?
        ORDER BY shinryokoi_code_2 LIMIT ${PROFILE_EXAMPLES}`, [edition, code, me, ms]);
      const kubunCounts = {};
      for (const r of agg) kubunCounts[r.haihan_kubun] = Number(r.n);
      p.haihanAite.push({table: `${table}(${edition})`, joken,
        total: agg.reduce((s, r) => s + Number(r.n), 0), kubunCounts,
        tokurei: agg.reduce((s, r) => s + Number(r.t), 0), examples});
    }
    const oyaWhere = `
      FROM hokatsu h JOIN hojo_master m ON m.edition = h.edition
       AND (m.group_bango_1 = h.group_bango OR m.group_bango_2 = h.group_bango
            OR m.group_bango_3 = h.group_bango)
      WHERE h.edition=? AND h.shinryokoi_code=?
        AND h.shinsetsu_ymd<=? AND h.haishi_ymd>=?
        AND m.shinsetsu_ymd<=? AND m.haishi_ymd>=?`;
    const oyaParams = [edition, code, me, ms, me, ms];
    p.hokatsuOyaTotal = Number((await rows(`SELECT count(*) AS n ${oyaWhere}`, oyaParams))[0].n);
    p.hokatsuOya = await rows(`
      SELECT m.shinryokoi_code AS oya_code, m.shinryokoi_shoryaku_meisho AS oya_name,
             h.group_bango AS grp, h.tokurei_joken AS tokurei,
             CASE WHEN m.group_bango_1 = h.group_bango THEN m.hokatsu_tani_1
                  WHEN m.group_bango_2 = h.group_bango THEN m.hokatsu_tani_2
                  ELSE m.hokatsu_tani_3 END AS tani
      ${oyaWhere} ORDER BY m.shinryokoi_code LIMIT ${PROFILE_EXAMPLES}`, oyaParams);
    const hojo = await rows(`
      SELECT hokatsu_tani_1, group_bango_1, hokatsu_tani_2, group_bango_2,
             hokatsu_tani_3, group_bango_3
      FROM hojo_master WHERE edition=? AND shinryokoi_code=?
        AND shinsetsu_ymd<=? AND haishi_ymd>=?`, [edition, code, me, ms]);
    for (const h of hojo.slice(0, 1)) {
      for (const i2 of [1, 2, 3]) {
        const g = h[`group_bango_${i2}`];
        if (!g || g === "0") continue;
        const agg = await rows(`
          SELECT count(*) AS n, sum(CASE WHEN tokurei_joken='1' THEN 1 ELSE 0 END) AS t
          FROM hokatsu WHERE edition=? AND group_bango=?
            AND shinsetsu_ymd<=? AND haishi_ymd>=?`, [edition, g, me, ms]);
        if (!agg.length || !Number(agg[0].n)) continue;
        const examples = await rows(`
          SELECT shinryokoi_code AS code, shinryokoi_shoryaku_meisho AS name,
                 tokurei_joken AS tokurei
          FROM hokatsu WHERE edition=? AND group_bango=?
            AND shinsetsu_ymd<=? AND haishi_ymd>=?
          ORDER BY shinryokoi_code LIMIT ${PROFILE_EXAMPLES}`, [edition, g, me, ms]);
        const tani = h[`hokatsu_tani_${i2}`];
        p.hokatsuKo.push({grp: g, tani: HOKATSU_TANI[tani] ?? `単位コード${tani}(不明)`,
          total: Number(agg[0].n), tokurei: Number(agg[0].t ?? 0), examples});
      }
    }
    if (ckEdition) {
      p.tekiouTable = `checkmaster_si_shobyo(${ckEdition})`;
      p.tekiouTotal = Number((await rows(`
        SELECT count(DISTINCT shobyomei_code) AS n FROM checkmaster_si_shobyo
        WHERE edition=? AND shinryokoi_code=? AND henko_kubun NOT IN ('1','9')
          AND shobyomei_code <> '0000000'`, [ckEdition, code]))[0].n);
      p.tekiouMujoken = Number((await rows(`
        SELECT count(*) AS n FROM checkmaster_si_shobyo
        WHERE edition=? AND shinryokoi_code=? AND henko_kubun NOT IN ('1','9')
          AND shobyomei_code = '0000000'`, [ckEdition, code]))[0].n);
      p.tekiouExamples = await rows(`
        SELECT DISTINCT s.shobyomei_code AS code, b.shobyomei_kihon_meisho AS name
        FROM checkmaster_si_shobyo s
        LEFT JOIN master_shobyomei b ON b.edition=? AND b.shobyomei_code = s.shobyomei_code
        WHERE s.edition=? AND s.shinryokoi_code=? AND s.henko_kubun NOT IN ('1','9')
          AND s.shobyomei_code <> '0000000'
        ORDER BY s.shobyomei_code LIMIT ${PROFILE_EXAMPLES}`, [edition, ckEdition, code]);
    }
    return p;
  }
  if (info.kind === "医薬品" && ckEdition) {
    const iyEdition = editionFor(ym, "iyakuhin");
    p.tekiouTable = `checkmaster_iy_tekio(${ckEdition})`;
    p.tekiouTotal = Number((await rows(`
      SELECT count(DISTINCT shobyomei_code) AS n FROM checkmaster_iy_tekio
      WHERE edition=? AND iyakuhin_code=? AND henko_kubun NOT IN ('1','9')
        AND shobyomei_code <> '0000000'`, [ckEdition, code]))[0].n);
    p.tekiouMujoken = Number((await rows(`
      SELECT count(*) AS n FROM checkmaster_iy_tekio
      WHERE edition=? AND iyakuhin_code=? AND henko_kubun NOT IN ('1','9')
        AND shobyomei_code = '0000000'`, [ckEdition, code]))[0].n);
    p.tekiouExamples = await rows(`
      SELECT DISTINCT t.shobyomei_code AS code, b.shobyomei_kihon_meisho AS name
      FROM checkmaster_iy_tekio t
      LEFT JOIN master_shobyomei b ON b.edition=? AND b.shobyomei_code = t.shobyomei_code
      WHERE t.edition=? AND t.iyakuhin_code=? AND t.henko_kubun NOT IN ('1','9')
        AND t.shobyomei_code <> '0000000'
      ORDER BY t.shobyomei_code LIMIT ${PROFILE_EXAMPLES}`, [edition, ckEdition, code]);
    p.kinkiTotal = Number((await rows(`
      SELECT count(DISTINCT kinki_shobyomei_code) AS n FROM checkmaster_iy_shobyokinki
      WHERE edition=? AND iyakuhin_code=? AND henko_kubun NOT IN ('1','9')`,
      [ckEdition, code]))[0].n);
    p.kinkiExamples = await rows(`
      SELECT DISTINCT k.kinki_shobyomei_code AS code, b.shobyomei_kihon_meisho AS name
      FROM checkmaster_iy_shobyokinki k
      LEFT JOIN master_shobyomei b ON b.edition=? AND b.shobyomei_code = k.kinki_shobyomei_code
      WHERE k.edition=? AND k.iyakuhin_code=? AND k.henko_kubun NOT IN ('1','9')
      ORDER BY k.kinki_shobyomei_code LIMIT ${PROFILE_EXAMPLES}`, [edition, ckEdition, code]);
    p.heiyoTotal = Number((await rows(`
      SELECT count(DISTINCT CASE WHEN iyakuhin_code_l=? THEN iyakuhin_code_r
                                 ELSE iyakuhin_code_l END) AS n
      FROM checkmaster_iy_heiyokinki
      WHERE edition=? AND (iyakuhin_code_l=? OR iyakuhin_code_r=?)
        AND henko_kubun NOT IN ('1','9')`, [code, ckEdition, code, code]))[0].n);
    p.heiyoExamples = await rows(`
      SELECT DISTINCT aite AS code, m.kanji_meisho AS name FROM (
        SELECT CASE WHEN iyakuhin_code_l=? THEN iyakuhin_code_r
                    ELSE iyakuhin_code_l END AS aite
        FROM checkmaster_iy_heiyokinki
        WHERE edition=? AND (iyakuhin_code_l=? OR iyakuhin_code_r=?)
          AND henko_kubun NOT IN ('1','9')
      ) LEFT JOIN master_iyakuhin m ON m.edition=? AND m.iyakuhin_code = aite
      ORDER BY aite LIMIT ${PROFILE_EXAMPLES}`,
      [code, ckEdition, code, code, iyEdition]);
  }
  return p;
}

/* ---------- 表示(report.py の移植) ---------- */
const refLink = (ref) =>
  `<a class="reflink" data-ref="${esc(ref)}">${esc(ref)}</a>`;
const gigiLink = (f) => `<a class="reflink" data-gigi="${esc(f)}">${esc(f)}</a>`;
const shinsaLink = (no, t) => `<a class="reflink" data-shinsa="${no}">No.${no}</a> ${esc(t)}`;

async function renderCheck(R) {
  const out = [];
  const banners = [];
  out.push(`=== 一次判定: 診療年月 ${esc(R.ym)}(適用版: ${esc(R.edition)}) ===`);
  const tokureiHits = R.hits.filter((h) => h.tokurei);
  if (tokureiHits.length) {
    banners.push("【要通知確認】特例条件=1 のヒットがあります。通知原文の確認が必須です:<br>" +
      tokureiHits.map((h) => `・${esc(h.title)}: ${esc(h.detail)}`).join("<br>"));
  }
  const kinkiReps = R.tekiou.filter((t) => t.kinki.length);
  if (kinkiReps.length) {
    banners.push("【禁忌の疑い】チェックマスタの禁忌傷病名に該当があります(機械判定・要原文確認):<br>" +
      kinkiReps.flatMap((t) => t.kinki.map((k) =>
        `・医薬品 ${esc(t.code)} ${esc(t.name ?? "")} × 禁忌傷病名 ${esc(k.kinki_shobyomei_code)} ${esc(R.infos[k.kinki_shobyomei_code]?.name ?? "名称不明")}(参照範囲=${esc(k.sansho_hani)})`)).join("<br>"));
  }
  if (R.heiyo.length) {
    banners.push("【併用禁忌の疑い】チェックマスタの併用禁忌の組合せに該当があります(機械判定・要添付文書確認):<br>" +
      R.heiyo.map((h) =>
        `・${esc(h.iyakuhin_code_l)} ${esc(R.infos[h.iyakuhin_code_l]?.name ?? "")} × ${esc(h.iyakuhin_code_r)} ${esc(R.infos[h.iyakuhin_code_r]?.name ?? "")}(参照範囲=${esc(h.sansho_hani)})`).join("<br>"));
  }
  const overDose = R.tekiou.flatMap((t) => t.dose.filter((d) => d.ryoOver || d.nissuOver)
    .map((d) => [t, d]));
  if (overDose.length) {
    banners.push("【投与量・日数上限超過の疑い】チェックマスタの上限値を超えています(機械判定・要原文確認):<br>" +
      overDose.map(([t, d]) => {
        const scope = d.dc ? `傷病名 ${d.dc} 条件` : "病名条件なしチェック";
        const parts = [];
        if (d.ryoOver) parts.push(`数量 ${d.ryo} > 上限 ${d.lr}` + (d.tekigi ? "(適宜増減の対象。原文確認)" : ""));
        if (d.nissuOver) parts.push(`投与日数 ${d.nissu} > 上限 ${d.ln}日`);
        return `・${esc(t.code)} ${esc(t.name ?? "")}(${esc(scope)}): ${esc(parts.join("、"))}`;
      }).join("<br>"));
  }

  out.push("", "--- コード情報 ---");
  for (const c of R.codes) {
    const i = R.infos[c];
    if (i.kind === "医薬品" || i.kind === "傷病名") {
      out.push(i.found ? `  ${esc(c)}: ${esc(i.name)}(種別=${i.kind} → 適応病名チェックの対象)`
        : `  ${esc(c)}: 種別=${i.kind} → マスターに収載なし。名称は不明`);
      continue;
    }
    if (i.kind !== "診療行為") {
      out.push(`  ${esc(c)}: 種別=${i.kind} → 電子点数表(診療行為)の判定対象外`);
      continue;
    }
    if (!i.found) {
      out.push(`  ${esc(c)}: 診療行為マスター(${esc(R.edition)})に収載なし → 名称・属性は不明`);
      continue;
    }
    out.push(`  ${esc(c)}: ${esc(i.name)} (区分番号 ${i.kubun ? refLink(i.kubun) : "不明"})`);
    if (i.expired) out.push(`      ※診療年月時点で廃止済み(廃止年月日=${esc(i.haishi)})`);
    if (i.nyugai && i.nyugai !== "0") out.push(`      入外適用区分=${esc(i.nyugai)}(${esc(NYUGAI[i.nyugai] ?? "不明")})`);
    if (i.tsusoku && i.tsusoku !== "0") out.push(`      通則年齢=${esc(i.tsusoku)}(値の意味は仕様説明書参照)`);
    if ((i.kagen && i.kagen !== "00") || (i.jogen && i.jogen !== "00"))
      out.push(`      下限年齢=${esc(i.kagen)}/上限年齢=${esc(i.jogen)}(特殊値は仕様説明書参照)`);
    if (i.shisetsu.length) out.push(`      施設基準コード=${esc(i.shisetsu.join(","))}(届出要否は施設基準告示・届出コード一覧で確認)`);
  }

  if (R.commentYoken.length) {
    out.push("", "--- 選択式コメント(摘要欄記載事項・要記載) ---");
    for (const cy of R.commentYoken) {
      out.push(`  ${esc(cy.code)} ${esc(cy.name ?? "")}: 記載が必要なコメント ${cy.rows.length}件`);
      for (const r of cy.rows) {
        const parts = [`コメントコード=${esc(r.comment_code)}`];
        if (r.comment_bunrei) parts.push(esc(r.comment_bunrei));
        if (r.joken) parts.push(`条件: ${esc(r.joken)}`);
        out.push(`    - ${parts.join("/")}`);
      }
      out.push(`    根拠: ${esc(cy.table)}(記載要領別表I相当。記載要領原文も確認)`);
    }
  }

  if (R.profile) renderProfile(out, R);

  if (R.shinryokoi.length >= 2) {
    out.push("", "--- 併算定判定(背反・包括) ---");
    for (const h of R.hits.filter((h) => h.kind === "haihan" || h.kind === "hokatsu")) {
      out.push(`${esc(h.title)}: ${esc(h.detail)}`);
      out.push(`根拠: ${esc(h.table)} 該当行:`);
      for (const e of h.evid) out.push(`  ${esc(e)}`);
      out.push(`次に確認: 留意事項通知・告示 ${h.refs.map(refLink).join(", ") || "(区分番号はマスター上不明)"}`, "");
    }
    for (const [a, b] of R.notListed) {
      out.push(`[収載なし] ${esc(a)} ${esc(R.infos[a].name ?? a)} × ${esc(b)} ${esc(R.infos[b].name ?? b)}: ${esc(NOT_LISTED)}`);
    }
    if (R.notListed.length) out.push("");
  }
  const nyuinHits = R.hits.filter((h) => h.kind === "nyuin");
  if (nyuinHits.length) {
    out.push("--- 入院基本料(入院料×加算) ---");
    for (const h of nyuinHits) {
      out.push(`${esc(h.title)}: ${esc(h.detail)}`);
      out.push(`根拠: ${esc(h.table)} 該当行:`);
      for (const e of h.evid) out.push(`  ${esc(e)}`);
      out.push("");
    }
  }
  if (R.drugs.length || R.diseases.length) {
    if (!ckEdition) {
      out.push("--- 適応病名チェック(チェックマスタ) ---", "  チェックマスタ未投入", "");
    } else {
      out.push(`--- 適応病名チェック(チェックマスタ ${esc(ckEdition)}版・機械判定) ---`);
      for (const t of R.tekiou) {
        const subj = `${esc(t.code)} ${esc(t.name ?? "(名称不明)")}`;
        if (!t.listed) {
          out.push(`  [${t.kind}] ${subj}: チェックマスタに収載なし → 適応判定不能(不明)`);
          continue;
        }
        out.push(`  [${t.kind}] ${subj}(収載 ${t.listedRows.toLocaleString()}行 / 根拠: ${esc(t.table)}):`);
        for (const m of t.matches) {
          out.push(`    ○ 適応に該当: ${esc(m.code)} ${esc(m.name ?? "(名称不明)")}`);
          for (const r of m.rows.slice(0, 3)) {
            const conds = [`性別=${r.seibetsu}`, `年齢=${r.nenrei_kagen}〜${r.nenrei_jogen}`];
            if ("saidai_toyoryo" in r) {
              if (r.saidai_toyoryo !== "99999.99999") conds.push(`最大投与量=${r.saidai_toyoryo}`);
              if (r.saicho_toyo_nissu !== "999") conds.push(`最長投与日数=${r.saicho_toyo_nissu}`);
            }
            if ("nyugai_kubun" in r) conds.push(`入外=${r.nyugai_kubun}`, `疑い病名=${r.utagai_byomei}`);
            conds.push(`参照範囲=${r.sansho_hani}`);
            out.push(`       ${esc(conds.join("/"))}`);
          }
        }
        for (const u of t.unmatched) {
          out.push(`    × ${esc(u.code)} ${esc(u.name ?? "(名称不明)")}: チェックマスタ上の適応傷病名に収載なし(適応外の確定ではない。添付文書・審査情報を確認)`);
        }
        if (t.mujoken) out.push(`    (参考: 傷病名を条件としない投与量・日数チェック行が ${t.mujoken} 行あり)`);
        for (const d of t.dose) {
          const scope = d.dc ? `傷病名${d.dc}条件` : "病名条件なし";
          const limits = [];
          if (d.lr) limits.push(`最大投与量=${d.lr}` + (d.tekigi ? "(適宜増減)" : ""));
          if (d.ln) limits.push(`最長投与日数=${d.ln}日`);
          const verdicts = [];
          if (d.ryoOver !== null) verdicts.push(`数量${d.ryo}→` + (d.ryoOver ? "上限超過【要確認】" : "上限内"));
          if (d.nissuOver !== null) verdicts.push(`日数${d.nissu}→` + (d.nissuOver ? "上限超過【要確認】" : "上限内"));
          const tail = verdicts.length ? ` / 入力照合: ${verdicts.join("、")}` : "(数量・日数を入力すると照合します)";
          out.push(`    投与量・日数(${esc(scope)}): ${esc(limits.join("、"))}${esc(tail)}`);
        }
        for (const g of t.groups) out.push(`    (参考)投与量グループ: ${esc(g.group_mei)} 規格値=${esc(g.kikaku_chi)} 上限(規格)=${esc(g.seigen_saidai_toyoryo_kikaku)} 対象フラグ=${esc(g.check_taisho_flag)} ※同成分合算のグループ判定は未実装`);
        for (const g of t.manzen) out.push(`    (参考)漫然投与グループ: ${esc(g.group_mei)} 漫然投与日数=${esc(g.manzen_toyo_nissu)} リセット日数=${esc(g.manzen_reset_nissu)} 係数=${esc(g.manzen_keisu)} ※複数月縦覧の判定は未実装`);
      }
      out.push("  ※チェックマスタは公開日時点の内容であり、以降の改定・新薬収載を反映していない可能性があります", "");
    }
  }
  if (R.kaisu.length) {
    out.push("--- 算定回数(参考表示) ---");
    for (const k of R.kaisu) {
      const units = k.rows.map((r) =>
        `${r.santei_tani_meisho}(${r.santei_tani_code})につき${r.santei_kaisu}回まで` +
        (r.tokurei_joken === "1" ? "【特例条件=1: 要通知確認】" : "")).join("、");
      out.push(`  ${esc(k.code)} ${esc(k.name)}: ${esc(units)}`);
    }
    out.push("");
  }

  // 関連情報(区分番号+名称で照合)
  const gigiLines = [], shinsaLines = [];
  const seenKeys = new Set();
  for (const c of R.codes) {
    const i = R.infos[c];
    const key = `${i.kubun}|${i.name}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const label = [i.kubun, i.name ?? c].filter(Boolean).join(" ");
    const gigiFiles = {};
    if (i.kubun) {
      let ref = i.kubun;
      let hit = await rows("SELECT loc, extra FROM doc_mention WHERE source='gigi' AND ref=?", [ref]);
      if (!hit.length) {
        const m = ref.match(/^([A-Z])(\d{3})(.*)$/);
        if (m && m[3] && !m[3].startsWith("-"))
          hit = await rows("SELECT loc, extra FROM doc_mention WHERE source='gigi' AND ref=?", [m[1] + m[2]]);
      }
      for (const h of hit) (gigiFiles[h.loc] ??= new Set(h.extra.split(",").map(Number)));
    }
    for (const v of nameVariants(i.name ?? "")) {
      const hit = await rows(
        "SELECT filename, page FROM doc_gigi_page WHERE body LIKE ? ESCAPE '\\'",
        [`%${likeEsc(v)}%`]);
      for (const h of hit) (gigiFiles[h.filename] ??= new Set()).add(Number(h.page));
    }
    const gg = Object.entries(gigiFiles).filter(([f]) => f.startsWith("gigi_"));
    const tt = Object.entries(gigiFiles).filter(([f]) => f.startsWith("jimu_teisei"));
    if (gg.length || tt.length) {
      const parts = gg.slice(0, 4).map(([f, p]) =>
        `${gigiLink(f)}(p.${[...p].sort((a, b) => a - b).slice(0, 4).join(",")})`);
      if (gg.length > 4) parts.push(`ほか${gg.length - 4}ファイル`);
      if (tt.length) parts.push(`訂正事務連絡${tt.length}件にも言及あり`);
      gigiLines.push(`  ${esc(label)}: ` + parts.join(" / "));
    }
    const sAll = new Map();
    if (i.kubun) {
      let hit = await rows("SELECT loc, extra FROM doc_mention WHERE source='shinsa' AND ref=?", [i.kubun]);
      if (!hit.length) {
        const m = i.kubun.match(/^([A-Z])(\d{3})(.*)$/);
        if (m && m[3] && !m[3].startsWith("-"))
          hit = await rows("SELECT loc, extra FROM doc_mention WHERE source='shinsa' AND ref=?", [m[1] + m[2]]);
      }
      for (const h of hit) sAll.set(Number(h.loc), h.extra);
    }
    for (const v of nameVariants(i.name ?? "")) {
      const hit = await rows(
        "SELECT no, title FROM doc_shinsa WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'",
        [`%${likeEsc(v)}%`, `%${likeEsc(v)}%`]);
      for (const h of hit) sAll.set(Number(h.no), h.title);
    }
    if (sAll.size) {
      const nos = [...sAll.keys()].sort((a, b) => a - b);
      for (const no of nos.slice(0, 3)) shinsaLines.push(`  ${esc(label)}: ${shinsaLink(no, sAll.get(no))}`);
      if (nos.length > 3) shinsaLines.push(`  ${esc(label)}: …ほか${nos.length - 3}件`);
    }
  }
  if (gigiLines.length || shinsaLines.length || R.jireiSummary.length) {
    out.push("--- 関連情報(参考・機械的な言及照合) ---");
    if (gigiLines.length) { out.push("■ 疑義解釈事務連絡での言及(区分番号・名称で照合):"); out.push(...gigiLines); }
    if (shinsaLines.length) { out.push("■ 審査の一般的な取扱いでの言及(区分番号・名称で照合):"); out.push(...shinsaLines); }
    if (R.jireiSummary.length) {
      out.push("■ コンピュータチェック公開事例(支払基金):");
      for (const j of R.jireiSummary) {
        const samples = j.samples.map((s) => `${s.jirei_code}(${s.check_kanten})`).join("、");
        out.push(`  ${esc(j.code)} ${esc(j.name ?? "")}: ${j.count}件(例: ${esc(samples)}) → <a class="reflink" data-jirei="${esc(j.code)}">事例本文を表示</a>`);
      }
    }
    out.push("※関連の抽出は区分番号・名称・コードの機械的な照合であり、網羅・的中を保証しません。" +
      "名称は収載表記(＋括弧・規格を除いた基本形)での照合のため、言い換え表現は拾えません。" +
      "原文の確認を省略しないでください。", "");
  }
  out.push("--- 注意(固定表示) ---", esc(UNLISTED_RULES_NOTE));
  return {banners, html: out.join("\n")};
}

function renderProfile(out, R) {
  const p = R.profile;
  const info = R.infos[p.code];
  const tekiouLines = () => {
    if (p.tekiouTotal) {
      out.push(`  収載 ${p.tekiouTotal}件(性別・年齢・入外等の条件付きを含む):`);
      for (const e of p.tekiouExamples) out.push(`    - ${esc(e.code)} ${esc(e.name ?? "(名称不明)")}`);
      if (p.tekiouTotal > p.tekiouExamples.length)
        out.push(`    …ほか${p.tekiouTotal - p.tekiouExamples.length}件(傷病名コードを併記して判定すると個別照合できます)`);
    } else if (p.tekiouMujoken) {
      out.push(`  傷病名を条件としない行のみ収載(${p.tekiouMujoken}行・投与量/日数チェック用) → 傷病名別の適応一覧は収載なし`);
    } else {
      out.push("  チェックマスタに収載なし → 適応判定不能(不明)");
    }
  };
  out.push("", `--- 単体プロファイル: ${esc(p.code)} ${esc(info.name ?? "")} ---`);
  if (p.kind === "診療行為") {
    out.push("■ 背反相手(このコードと併算定調整があるテーブル収載分):");
    if (p.haihanAite.length) {
      for (const h of p.haihanAite) {
        const parts = [];
        if (h.kubunCounts["1"]) parts.push(`自コード側を算定=${h.kubunCounts["1"]}件`);
        if (h.kubunCounts["2"]) parts.push(`相手側を算定(自コードが算定不可)=${h.kubunCounts["2"]}件`);
        if (h.kubunCounts["3"]) parts.push(`いずれか一方=${h.kubunCounts["3"]}件`);
        const tk = h.tokurei ? `、特例条件=1が${h.tokurei}件` : "";
        out.push(`  ${esc(h.joken)}: ${h.total}件(${parts.join("/")}${tk})`);
        for (const e of h.examples)
          out.push(`    - ${esc(e.code)} ${esc(e.name)}(区分${esc(e.kubun)})${e.tokurei === "1" ? "【要通知確認】" : ""}`);
        if (h.total > h.examples.length)
          out.push(`    …ほか${h.total - h.examples.length}件(根拠: ${esc(h.table)})`);
      }
    } else {
      out.push("  4テーブルとも収載なし(未収載パターンの可能性あり。併算定可の意味ではない)");
    }
    out.push("■ 包括関係:");
    if (p.hokatsuOyaTotal) {
      out.push(`  このコードを包括する項目(親・算定時にこのコードが包括される): ${p.hokatsuOyaTotal}件`);
      for (const o of p.hokatsuOya)
        out.push(`    - ${esc(o.oya_code)} ${esc(o.oya_name)}(包括単位: ${esc(HOKATSU_TANI[o.tani] ?? `単位コード${o.tani}`)})[グループ${esc(o.grp)}]${o.tokurei === "1" ? "【要通知確認】" : ""}`);
      if (p.hokatsuOyaTotal > p.hokatsuOya.length)
        out.push(`    …ほか${p.hokatsuOyaTotal - p.hokatsuOya.length}件`);
    }
    for (const g of p.hokatsuKo) {
      const tk = g.tokurei ? `、特例条件=1が${g.tokurei}件` : "";
      out.push(`  このコードが包括する項目(被包括・${esc(g.tani)}[グループ${esc(g.grp)}]): ${g.total}件${tk}`);
      for (const e of g.examples)
        out.push(`    - ${esc(e.code)} ${esc(e.name)}${e.tokurei === "1" ? "【要通知確認】" : ""}`);
      if (g.total > g.examples.length) out.push(`    …ほか${g.total - g.examples.length}件`);
    }
    if (!p.hokatsuOyaTotal && !p.hokatsuKo.length)
      out.push("  包括・被包括テーブルに収載なし(被包括項目が明記されない包括あり。包括されない意味ではない)");
    if (p.tekiouTable) {
      out.push(`■ 適応傷病名の逆引き(チェックマスタ ${esc(p.tekiouTable)}):`);
      tekiouLines();
    }
  } else if (p.kind === "医薬品" && p.tekiouTable) {
    out.push(`■ 適応傷病名の逆引き(チェックマスタ ${esc(p.tekiouTable)}):`);
    tekiouLines();
    out.push(`■ 禁忌傷病名(checkmaster_iy_shobyokinki): ${p.kinkiTotal}件`);
    for (const e of p.kinkiExamples) out.push(`    - ${esc(e.code)} ${esc(e.name ?? "(名称不明)")}`);
    if (p.kinkiTotal > p.kinkiExamples.length) out.push(`    …ほか${p.kinkiTotal - p.kinkiExamples.length}件`);
    out.push(`■ 併用禁忌の相手医薬品(checkmaster_iy_heiyokinki): ${p.heiyoTotal}件`);
    for (const e of p.heiyoExamples) out.push(`    - ${esc(e.code)} ${esc(e.name ?? "(名称不明)")}`);
    if (p.heiyoTotal > p.heiyoExamples.length) out.push(`    …ほか${p.heiyoTotal - p.heiyoExamples.length}件`);
  }
  out.push("※相手一覧・逆引きはテーブル収載分のみです。一覧に無いことは併算定可・適応可を意味しません(未収載ルール・条件は原文で確認)。");
}

/* ---------- 検索(search.py の移植) ---------- */
let cart = [];
async function runSearch(query) {
  const q = toHw(query.trim());
  const result = {mode: "", rows: [], total: 0};
  const push = (kind, r) => result.rows.push({kind, ...r});
  const like = `%${likeEsc(q)}%`;
  const ed = async (t) => (await rows(`SELECT max(edition) AS e FROM ${t}`))[0]?.e;
  if (/^\d{9}$/.test(q)) {
    result.mode = "code";
    if (q[0] === "1") {
      for (const r of await rows(`SELECT shinryokoi_code AS code, shoryaku_kanji_meisho AS name, ${KUBUN_EXPR} AS kubun, shin_matawa_gen_tensu AS value, haishi_ymd FROM master_shinryokoi WHERE edition=? AND shinryokoi_code=?`, [await ed("master_shinryokoi"), q])) push("診療行為", r);
    } else if (q[0] === "6") {
      for (const r of await rows("SELECT iyakuhin_code AS code, kanji_meisho AS name, shin_mata_wa_gen_kingaku AS value, haishi_ymd FROM master_iyakuhin WHERE edition=? AND iyakuhin_code=?", [await ed("master_iyakuhin"), q])) push("医薬品", r);
    } else if (q[0] === "7") {
      for (const r of await rows("SELECT tokutei_kizai_code AS code, kanji_meisho AS name, shin_matawa_gen_kingaku AS value, haishi_ymd FROM master_kizai WHERE edition=? AND tokutei_kizai_code=?", [await ed("master_kizai"), q])) push("特定器材", r);
    }
  } else if (/^\d{7}$/.test(q)) {
    result.mode = "code";
    for (const r of await rows("SELECT shobyomei_code AS code, shobyomei_kihon_meisho AS name, haishi_ymd FROM master_shobyomei WHERE edition=? AND shobyomei_code=?", [await ed("master_shobyomei"), q])) push("傷病名", r);
  } else if (/^[A-Za-z][0-9\-]*$/.test(q)) {
    result.mode = "kubun";
    const all = await rows(`SELECT shinryokoi_code AS code, shoryaku_kanji_meisho AS name, ${KUBUN_EXPR} AS kubun, shin_matawa_gen_tensu AS value, haishi_ymd FROM master_shinryokoi WHERE edition=? AND ${KUBUN_EXPR} LIKE ? ESCAPE '\\' ORDER BY kubun, code`, [await ed("master_shinryokoi"), likeEsc(q.toUpperCase()) + "%"]);
    result.total = all.length;
    for (const r of all.slice(0, 100)) push("診療行為", r);
  } else {
    result.mode = "name";
    const s1 = await rows(`SELECT shinryokoi_code AS code, shoryaku_kanji_meisho AS name, ${KUBUN_EXPR} AS kubun, shin_matawa_gen_tensu AS value, haishi_ymd FROM master_shinryokoi WHERE edition=? AND (shoryaku_kanji_meisho LIKE ? ESCAPE '\\' OR kihon_kanji_meisho LIKE ? ESCAPE '\\' OR shoryaku_kana_meisho LIKE ? ESCAPE '\\') ORDER BY kubun, code`, [await ed("master_shinryokoi"), like, like, like]);
    const s2 = await rows("SELECT iyakuhin_code AS code, kanji_meisho AS name, shin_mata_wa_gen_kingaku AS value, haishi_ymd FROM master_iyakuhin WHERE edition=? AND (kanji_meisho LIKE ? ESCAPE '\\' OR kana_meisho LIKE ? ESCAPE '\\') ORDER BY code", [await ed("master_iyakuhin"), like, like]);
    const s3 = await rows("SELECT tokutei_kizai_code AS code, kanji_meisho AS name, shin_matawa_gen_kingaku AS value, haishi_ymd FROM master_kizai WHERE edition=? AND (kanji_meisho LIKE ? ESCAPE '\\' OR kana_meisho LIKE ? ESCAPE '\\') ORDER BY code", [await ed("master_kizai"), like, like]);
    const s4 = await rows("SELECT shobyomei_code AS code, shobyomei_kihon_meisho AS name, haishi_ymd FROM master_shobyomei WHERE edition=? AND (shobyomei_kihon_meisho LIKE ? ESCAPE '\\' OR shobyomei_shoryaku_meisho LIKE ? ESCAPE '\\' OR shobyomei_kana_meisho LIKE ? ESCAPE '\\') ORDER BY code", [await ed("master_shobyomei"), like, like, like]);
    result.total = s1.length + s2.length + s3.length + s4.length;
    for (const [kind, arr] of [["診療行為", s1], ["医薬品", s2], ["特定器材", s3], ["傷病名", s4]])
      for (const r of arr) { if (result.rows.length >= 100) break; push(kind, r); }
  }
  if (!result.total) result.total = result.rows.length;
  return result;
}

function renderCart() {
  if (!cart.length) { $("selPanel").innerHTML = ""; return; }
  const items = cart.map((it) =>
    `${esc(it.code)} ${esc(it.name ?? "")} <a class="reflink" data-uncart="${esc(it.code)}">[×外す]</a>`).join("<br>");
  $("selPanel").innerHTML = `<fieldset><legend>選択中のコード(${cart.length}件)</legend>${items}
    <p><a class="reflink" id="toCheck" style="font-weight:bold">→ この${cart.length}件で判定画面へ</a>
    / <a class="reflink" id="clearCart">全て外す</a></p></fieldset>`;
}

function renderSearch(res) {
  if (!res.rows.length) {
    $("searchResult").innerHTML = "<p>該当なし。名称は収載表記(カナは半角カナ等)のため、表記を変えて再検索してみてください。</p>";
    return;
  }
  const trs = res.rows.map((r) => {
    const inCart = cart.some((c) => c.code === r.code);
    return `<tr><td>${esc(r.kind)}</td><td>${esc(r.code)}</td>
      <td>${esc(r.name ?? "")}${r.haishi_ymd && r.haishi_ymd !== "99999999" ? ' <span class="expired">【廃止済み】</span>' : ""}</td>
      <td>${r.kubun ? `<a class="reflink" data-ref="${esc(r.kubun)}">${esc(r.kubun)}</a>` : ""}</td>
      <td>${esc(r.value && r.value !== "0" ? r.value : "")}</td>
      <td><a class="reflink" data-cart="${esc(r.code)}" data-name="${esc(r.name ?? "")}">${inCart ? "選択中" : "＋判定に追加"}</a></td></tr>`;
  }).join("");
  $("searchResult").innerHTML =
    `<p>ヒット ${res.total}件${res.total > res.rows.length ? `(先頭${res.rows.length}件を表示)` : ""}</p>
     <table class="results"><tr><th>種別</th><th>コード</th><th>名称</th><th>区分番号</th><th>点数/金額</th><th></th></tr>${trs}</table>`;
}

/* ---------- 条文・文書表示 ---------- */
async function showRef(ref) {
  ref = toHw(ref.trim()).toUpperCase();
  const parts = [];
  for (const [source, label] of [["tsuchi", "留意事項通知(医科)"], ["kokuji", "告示・医科点数表"]]) {
    const f = await resolveRef(ref, source);
    if (!f) continue;
    const sec = await rows("SELECT body FROM doc_section WHERE source=? AND filename=?", [source, f]);
    if (sec.length) parts.push(`===== ${label} =====\n\n${sec[0].body}`);
  }
  $("refResult").innerHTML = parts.length
    ? `<pre>${esc(parts.join("\n\n"))}</pre>`
    : `<p class="error">${esc(ref)}: 通知・告示に個別記載の見出しがありません(通則・原本PDFを確認)</p>`;
  activateTab("ref");
}
async function showGigi(file) {
  const pages = await rows("SELECT page, body FROM doc_gigi_page WHERE filename=? ORDER BY CAST(page AS INT)", [file]);
  const text = pages.map((p) => `## p.${p.page}\n${p.body}`).join("\n\n");
  $("refResult").innerHTML = `<h3>${esc(file)}</h3><pre>${esc(text)}</pre>`;
  activateTab("ref");
}
async function showShinsa(no) {
  const e = await rows("SELECT no, title, body FROM doc_shinsa WHERE no=?", [String(no)]);
  if (!e.length) return;
  $("refResult").innerHTML =
    `<h3>審査の一般的な取扱い No.${e[0].no} ${esc(e[0].title)}</h3><pre>${esc(e[0].body)}</pre>`;
  activateTab("ref");
}
async function showJirei(code) {
  const rws = await rows(`
    SELECT jirei_code, meisho, check_taisho, check_kanten, check_naiyo, check_konkyo,
           konkyo, sansho_hani, kokai_ymd
    FROM checkmaster_cc_jirei WHERE edition=? AND master_code=? AND henko_kubun NOT IN ('1','9')
    ORDER BY jirei_code`, [ckEdition, code]);
  const text = rws.map((r) =>
    `[${r.jirei_code}] 観点=${r.check_kanten} 対象=${r.check_taisho} 参照範囲=${r.sansho_hani} 根拠=${r.konkyo || "-"} 公開=${r.kokai_ymd}\n  チェック内容: ${r.check_naiyo}\n  チェック根拠: ${r.check_konkyo}`).join("\n\n");
  $("refResult").innerHTML =
    `<h3>コンピュータチェック公開事例 ${esc(code)}(${rws.length}件)</h3><pre>${esc(text)}</pre>`;
  activateTab("ref");
}

/* ---------- UI ---------- */
function activateTab(name) {
  document.querySelectorAll("nav a[data-tab]").forEach((a) =>
    a.classList.toggle("active", a.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.id === `tab-${name}`));
}

function parseKv(text) {
  const out = {};
  for (const tok of text.trim().split(/[\s,、]+/)) {
    if (!tok) continue;
    const [c, v] = tok.split("=");
    const f = parseFloat(v);
    if (!Number.isNaN(f)) out[c] = f;
  }
  return out;
}

async function onRunCheck() {
  const codes = $("codes").value.trim().split(/[\s,、]+/).filter(Boolean).map(toHw);
  if (!codes.length) { $("checkResult").innerHTML = '<p class="error">コードを入力してください</p>'; return; }
  $("checkBanners").innerHTML = ""; $("checkResult").innerHTML = "<p>判定中…</p>";
  try {
    const R = await runCheck(codes, $("ym").value, parseKv($("ryo").value), parseKv($("nissu").value));
    const {banners, html} = await renderCheck(R);
    $("checkBanners").innerHTML = banners.map((b) => `<div class="warn">${b}</div>`).join("");
    $("checkResult").innerHTML = `<pre>${html}</pre>`;
  } catch (e) {
    $("checkResult").innerHTML = `<p class="error">エラー: ${esc(e.message)}</p>`;
  }
}

document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("a");
  if (!t) return;
  if (t.dataset.tab) { activateTab(t.dataset.tab); return; }
  if (t.dataset.ref) { await showRef(t.dataset.ref); return; }
  if (t.dataset.gigi) { await showGigi(t.dataset.gigi); return; }
  if (t.dataset.shinsa) { await showShinsa(t.dataset.shinsa); return; }
  if (t.dataset.jirei) { await showJirei(t.dataset.jirei); return; }
  if (t.dataset.cart) {
    if (!cart.some((c) => c.code === t.dataset.cart))
      cart.push({code: t.dataset.cart, name: t.dataset.name});
    renderCart();
    t.textContent = "選択中";
    return;
  }
  if (t.dataset.uncart) {
    cart = cart.filter((c) => c.code !== t.dataset.uncart);
    renderCart();
    return;
  }
  if (t.id === "toCheck") {
    $("codes").value = cart.map((c) => c.code).join(" ");
    activateTab("check");
    return;
  }
  if (t.id === "clearCart") { cart = []; renderCart(); return; }
  if (t.id === "resetData") {
    await idbDel("dataZip");
    location.reload();
  }
});

$("runCheck").addEventListener("click", onRunCheck);
$("runSearch").addEventListener("click", async () => {
  $("searchResult").innerHTML = "<p>検索中…</p>";
  try { renderSearch(await runSearch($("searchQ").value)); }
  catch (e) { $("searchResult").innerHTML = `<p class="error">エラー: ${esc(e.message)}</p>`; }
});
$("searchQ").addEventListener("keydown", (e) => { if (e.key === "Enter") $("runSearch").click(); });
$("runRef").addEventListener("click", () => showRef($("refQ").value));
$("refQ").addEventListener("keydown", (e) => { if (e.key === "Enter") $("runRef").click(); });

$("zipfile").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  let buf;
  try {
    buf = await f.arrayBuffer();
    await initDb(buf);
  } catch (e) {
    $("loading").innerHTML = `<span class="error">読み込み失敗: ${esc(e.message)}</span>`;
    return;
  }
  try {
    await idbSet("dataZip", buf);
  } catch (e) {
    $("dataInfo").textContent +=
      ` ※ブラウザにデータを保存できませんでした(${e.message})。次回もzipの選択が必要です。` +
      "シークレットウィンドウや「終了時にサイトデータを削除」設定が原因のことがあります";
  }
});

(async () => {
  // 追い出し(ブラウザによる自動削除)への耐性を上げる。拒否されても続行
  try { await navigator.storage?.persist?.(); } catch { /* 任意機能 */ }
  let cached = null;
  try { cached = await idbGet("dataZip"); } catch { /* 破損時は初回扱い */ }
  if (cached) {
    try {
      $("loading").textContent = "保存済みデータを読み込み中…(初期化に数秒〜数十秒かかります)";
      await initDb(cached);
      return;
    } catch (e) {
      $("loading").innerHTML = `<span class="error">保存済みデータの読み込みに失敗しました。zipを選択し直してください(${esc(e.message)})</span>`;
    }
  } else {
    $("loading").textContent = "";
  }
  $("pickerBlock").style.display = "block";
})();
