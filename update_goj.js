// 政府統計（e-Stat 本体API ver3.0）から統計データを取得する。
// gojlist.csv に列挙された系列だけを getStatsData で取得し、
// data/goj/<カテゴリ>.csv（ワイド形式）と data/goj/_catalog.csv を出力する。
// gojlist.csv が「収集」と「表示」の単一ソース。
//
// このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、
// サービスの内容は国によって保証されたものではありません。
//
// ・アプリケーションID(appId)が必要。環境変数 ESTAT_APPID から読み込む。
// ・高頻度アクセス回避のためリクエスト間に間隔を空ける。

const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "data", "goj");
const LIST_FILE = path.join(ROOT, "gojlist.csv");

const HOST = "api.e-stat.go.jp";
const BASE = "/rest/3.0/app/json/getStatsData";
const APP_ID = process.env.ESTAT_APPID || "";

const PAGE_LIMIT = 100000; // 1リクエストの最大取得件数
const SLEEP_MS = 1500;     // 高頻度アクセス回避
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGetJson(pathWithQuery) {
  return new Promise((resolve, reject) => {
    https.get(
      { host: HOST, path: pathWithQuery, headers: { "User-Agent": "goj_boj-estat/1.0", "Accept": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse失敗: ${e.message} body=${text.slice(0, 300)}`)); }
        });
      }
    ).on("error", reject);
  });
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// gojlist.csv を読む。列: 表示名,カテゴリ,統計表ID,分類コード,集約
function parseList(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.replace(/^﻿/, "").replace(/^"+|"+$/g, "").trim());
  const iName = header.indexOf("表示名");
  const iCat = header.indexOf("カテゴリ");
  const iId = header.indexOf("統計表ID");
  const iCls = header.indexOf("分類コード");
  const iAgg = header.indexOf("集約");
  if (iName < 0 || iCat < 0 || iId < 0) throw new Error("gojlist.csv: 必須列(表示名/カテゴリ/統計表ID)がありません");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]).map((c) => c.replace(/^"+|"+$/g, "").trim());
    const name = cols[iName], cat = cols[iCat], id = cols[iId];
    if (!name || !cat || !id) continue;
    rows.push({
      name, cat, statsDataId: id,
      cls: iCls >= 0 ? (cols[iCls] || "") : "",
      agg: (iAgg >= 0 ? (cols[iAgg] || "") : "").toLowerCase() === "sum" ? "sum" : "last",
    });
  }
  return rows;
}

function parseCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// 分類コード "cat01=001;cat02=00" -> { cat01:"001", cat02:"00" }
function parseClassFilter(s) {
  const f = {};
  for (const part of String(s || "").split(";")) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (m) f[m[1].trim()] = m[2].trim();
  }
  return f;
}

// 時間軸の名称/コードを共通形式（YYYY-MM-DD / YYYY-MM）へ正規化する。
function normalizeTime(name, code) {
  const n = String(name || "").trim();
  let m;
  if ((m = n.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/))) return `${m[1]}-${z2(m[2])}-${z2(m[3])}`;
  if ((m = n.match(/(\d{4})年\s*(\d{1,2})月/))) return `${m[1]}-${z2(m[2])}`;
  if ((m = n.match(/(\d{4})年.*?第\s*([1-4１-４Ⅰ-Ⅳ])\s*四半期/))) {
    const q = "1234".indexOf(toAsciiDigit(m[2])) + 1 || 1;
    return `${m[1]}-${["03", "06", "09", "12"][q - 1]}`;
  }
  if ((m = n.match(/(\d{4})年度/))) return `${m[1]}-12`;
  if ((m = n.match(/(\d{4})年/))) return `${m[1]}-12`;
  // フォールバック: コード先頭4桁を年とみなす
  const c = String(code || "").trim();
  if (/^\d{4}/.test(c)) return `${c.slice(0, 4)}-12`;
  return n || c;
}
// 時間軸の頻度ランク（大きいほど細かい）。同一系列に月次・四半期・年度・暦年が
// 混在する表で、最も細かい頻度だけを残すために使う。これを入れないと normalizeTime が
// 「YYYY年」「YYYY年度」を「YYYY-12」に丸め、12月の月次値（や第4四半期値）を年次値で
// 上書きしてしまう。
function timeRank(name, code) {
  const n = String(name || "").trim();
  if (/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.test(n)) return 5; // 日次
  if (/(\d{4})年\s*(\d{1,2})月/.test(n)) return 4;               // 月次
  if (/第\s*[1-4１-４Ⅰ-Ⅳ]\s*四半期/.test(n)) return 3;          // 四半期
  if (/(\d{4})年度/.test(n)) return 2;                           // 年度
  if (/(\d{4})年/.test(n)) return 1;                             // 暦年
  return 0;                                                      // 不明（コード先頭4桁）
}
function z2(s) { return String(s).padStart(2, "0"); }
function toAsciiDigit(s) {
  const map = { "１": "1", "２": "2", "３": "3", "４": "4", "Ⅰ": "1", "Ⅱ": "2", "Ⅲ": "3", "Ⅳ": "4" };
  return map[s] || s;
}

function asArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

// 1系列分を getStatsData で取得し、{date->value} と メタ情報を返す。
async function fetchSeries(entry) {
  const filter = parseClassFilter(entry.cls);
  const collected = []; // {date, num, rank}
  let maxRank = -1;
  let timeMeta = new Map(); // time code -> name
  let unit = "", tableName = "", freq = "";
  let startPosition = null, guard = 0;

  while (guard++ < 200) {
    const params = new URLSearchParams({
      appId: APP_ID,
      statsDataId: entry.statsDataId,
      metaGetFlg: "Y",
      cntGetFlg: "N",
      limit: String(PAGE_LIMIT),
    });
    // 分類コードをリクエストにも反映（cat01 等は cdCat01 パラメータ）
    for (const [id, code] of Object.entries(filter)) {
      const pname = id.startsWith("cat") ? "cdCat" + id.slice(3) : "cd" + id.charAt(0).toUpperCase() + id.slice(1);
      params.set(pname, code);
    }
    if (startPosition != null) params.set("startPosition", String(startPosition));

    const json = await httpsGetJson(`${BASE}?${params.toString()}`);
    const gsd = json && json.GET_STATS_DATA;
    const result = gsd && gsd.RESULT;
    if (!result || String(result.STATUS) !== "0") {
      throw new Error(`getStatsData STATUS ${result ? result.STATUS : "?"}: ${result ? (result.ERROR_MSG || "").trim() : "no RESULT"}`);
    }
    const sd = gsd.STATISTICAL_DATA || {};
    const tinf = sd.TABLE_INF || {};
    tableName = String((tinf.TITLE && (tinf.TITLE.$ || tinf.TITLE)) || tinf.STATISTICS_NAME || "").trim();

    // メタ: 時間軸 code->name、単位
    const classObjs = asArray(sd.CLASS_INF && sd.CLASS_INF.CLASS_OBJ);
    for (const obj of classObjs) {
      if (obj["@id"] === "time") {
        for (const c of asArray(obj.CLASS)) timeMeta.set(String(c["@code"]), String(c["@name"] || ""));
      }
    }

    // データ
    const values = asArray(sd.DATA_INF && sd.DATA_INF.VALUE);
    for (const v of values) {
      // 分類フィルタ（リクエストで絞れていない次元を念のため照合）
      let ok = true;
      for (const [id, code] of Object.entries(filter)) {
        if (String(v["@" + id]) !== String(code)) { ok = false; break; }
      }
      if (!ok) continue;
      const tcode = String(v["@time"] || "");
      const raw = v["$"];
      if (raw == null || raw === "" || raw === "-" || raw === "***") continue;
      const num = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(num)) continue;
      if (!unit && v["@unit"]) unit = String(v["@unit"]);
      const tname = timeMeta.get(tcode);
      const rank = timeRank(tname, tcode);
      const date = normalizeTime(tname, tcode);
      collected.push({ date, num, rank });
      if (rank > maxRank) maxRank = rank;
    }

    const rinf = sd.RESULT_INF || {};
    const nextKey = rinf.NEXT_KEY;
    if (nextKey == null || nextKey === "" ) break;
    startPosition = nextKey;
    await sleep(SLEEP_MS);
  }

  // 最も細かい頻度の観測値だけを採用（年次・年度の丸めによる月末値の上書きを防ぐ）。
  const valueMap = new Map();
  for (const r of collected) if (r.rank === maxRank) valueMap.set(r.date, r.num);

  return { valueMap, unit, tableName, freq };
}

async function main() {
  if (!APP_ID) { console.error("環境変数 ESTAT_APPID（e-StatアプリケーションID）が未設定です。"); process.exit(1); }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const list = parseList(fs.readFileSync(LIST_FILE, "utf8"));
  if (list.length === 0) { console.error("gojlist.csv に有効な系列がありません（統計表IDを記入してください）。"); process.exit(1); }

  // カテゴリ単位にまとめる（順序保持）
  const byCat = new Map();
  for (const e of list) { if (!byCat.has(e.cat)) byCat.set(e.cat, []); byCat.get(e.cat).push(e); }

  console.log(`e-Stat 政府統計の取得を開始します（系列数=${list.length}, カテゴリ数=${byCat.size}）`);
  const catalog = [];

  for (const [cat, entries] of byCat) {
    const seriesData = []; // {name, map}
    for (const e of entries) {
      try {
        const r = await fetchSeries(e);
        if (r.valueMap.size === 0) { console.warn(`⚠ ${cat}/${e.name}: データ0件（統計表ID/分類コードを確認）`); }
        seriesData.push({ name: e.name, map: r.valueMap });
        catalog.push({ name: e.name, cat, statsDataId: e.statsDataId, unit: r.unit, table: r.tableName, agg: e.agg });
        console.log(`✅ ${cat}/${e.name}: ${r.valueMap.size}期`);
      } catch (err) {
        console.error(`❌ ${cat}/${e.name}: ${err.message}`);
        seriesData.push({ name: e.name, map: new Map() });
      }
      await sleep(SLEEP_MS);
    }

    // ワイドCSV出力（Date + 各表示名列）
    const allDates = new Set();
    for (const s of seriesData) for (const d of s.map.keys()) allDates.add(d);
    const sortedDates = Array.from(allDates).sort();
    const names = seriesData.map((s) => s.name);
    const lines = [["Date", ...names].map(csvEscape).join(",")];
    for (const d of sortedDates) {
      const row = [d];
      for (const s of seriesData) row.push(s.map.has(d) ? s.map.get(d) : "");
      lines.push(row.map(csvEscape).join(","));
    }
    fs.writeFileSync(path.join(OUT_DIR, `${cat}.csv`), lines.join("\n") + "\n", "utf8");
    console.log(`📄 data/goj/${cat}.csv（系列${names.length} / 期間${sortedDates.length}）`);
  }

  const catHeader = ["name", "cat", "statsDataId", "unit", "table", "agg"];
  const catLines = [catHeader.join(",")];
  for (const c of catalog) catLines.push(catHeader.map((k) => csvEscape(c[k])).join(","));
  fs.writeFileSync(path.join(OUT_DIR, "_catalog.csv"), catLines.join("\n") + "\n", "utf8");
  console.log(`catalog: data/goj/_catalog.csv（系列 ${catalog.length}）`);
  console.log("すべての処理が完了しました。");
}

main();
