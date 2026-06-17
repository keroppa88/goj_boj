// 日本銀行「時系列統計データ検索サイト」API から政府統計を取得する。
// bojlist.csv に列挙された系列だけをコードAPI(getDataCode)で取得し、
// data/boj/<ファイル>.csv（ワイド形式）と _catalog.csv を出力する。
// bojlist.csv が「収集」と「表示」の単一ソース。
//
// このサービスは、日本銀行時系列統計データ検索サイトのAPI機能を使用しています。
// サービスの内容は日本銀行によって保証されたものではありません。
//
// ・APIキー不要。高頻度アクセス禁止のためリクエスト間に間隔を空ける。

const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "data", "boj");
const LIST_FILE = path.join(ROOT, "bojlist.csv");
const HOST = "www.stat-search.boj.or.jp";
const CODE_BASE = "/api/v1/getDataCode";

const START_DATE = process.env.BOJ_START || "200001"; // YYYYMM
const CODE_BATCH = 200;   // 1リクエストの系列コード数上限は250。安全側で200。
const SLEEP_MS = 1500;    // 高頻度アクセス回避
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGetGzip(pathWithQuery) {
  return new Promise((resolve, reject) => {
    https.get(
      { host: HOST, path: pathWithQuery, headers: { "Accept-Encoding": "gzip", "User-Agent": "jpx_data-boj/1.0" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          try { if ((res.headers["content-encoding"] || "").includes("gzip")) buf = zlib.gunzipSync(buf); }
          catch (e) { return reject(new Error("gunzip失敗: " + e.message)); }
          const text = buf.toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          resolve(text);
        });
      }
    ).on("error", reject);
  });
}

function findSeriesArray(node) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && "SERIES_CODE" in x)) return node;
    for (const el of node) { const r = findSeriesArray(el); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") for (const k of Object.keys(node)) { const r = findSeriesArray(node[k]); if (r) return r; }
  return null;
}

function getNextPosition(json) {
  if (json && json.NEXTPOSITION != null) {
    const s = String(json.NEXTPOSITION).trim();
    if (s !== "" && s !== "null") { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; }
  }
  return null;
}

function checkStatus(json, ctx) {
  const status = json && json.STATUS != null ? String(json.STATUS) : "";
  if (status && status !== "200") throw new Error(`${ctx} STATUS ${status}: ${(json.MESSAGE || "").trim()}`);
}

// 系列オブジェクトから時期配列・値配列を取り出す。
// getDataCode では VALUES が { SURVEY_DATES:[...], VALUES:[...] } の入れ子になっている。
function extractSeriesDV(s) {
  const w = s && s.VALUES && typeof s.VALUES === "object" && !Array.isArray(s.VALUES) ? s.VALUES : null;
  const dates = w ? (w.SURVEY_DATES || []) : (s.SURVEY_DATES || []);
  const values = w ? (w.VALUES || []) : (Array.isArray(s.VALUES) ? s.VALUES : []);
  return { dates: Array.isArray(dates) ? dates : [], values: Array.isArray(values) ? values : [] };
}

// SURVEY_DATES の各期を共通形式（YYYY-MM-DD / YYYY-MM）に正規化する。
function normalizeDate(raw, freq) {
  const s = String(raw || "").trim();
  const f = String(freq || "").toUpperCase();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (f.startsWith("QUARTERLY") && /^\d{6}$/.test(s)) {
    const q = parseInt(s.slice(4, 6), 10);
    return `${s.slice(0, 4)}-${["03", "06", "09", "12"][Math.max(1, Math.min(4, q)) - 1]}`;
  }
  if (f.startsWith("SEMIANNUAL") && /^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${parseInt(s.slice(4, 6), 10) === 2 ? "12" : "06"}`;
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  if (/^\d{4}$/.test(s)) return `${s}-12`;
  return s;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// bojlist.csv を読み、ファイル単位の収集スペックに変換する。
function parseList(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.replace(/^﻿/, "").replace(/^"+|"+$/g, "").trim());
  const idxFile = header.indexOf("ファイル");
  const idxCode = header.indexOf("系列コード");
  const idxAgg = header.indexOf("集約");
  if (idxFile < 0 || idxCode < 0) throw new Error("bojlist.csv: 必須列(ファイル/系列コード)がありません");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.replace(/^"+|"+$/g, "").trim());
    const file = cols[idxFile], code = cols[idxCode];
    if (!file || !code) continue;
    rows.push({ file, code, agg: (idxAgg >= 0 ? (cols[idxAgg] || "") : "").toLowerCase() });
  }
  return rows;
}

// ファイル名(例 FM08_D)から DB名・期種サフィックスを得る。
function splitFile(file) {
  const i = file.lastIndexOf("_");
  return i > 0 ? { db: file.slice(0, i), suffix: file.slice(i + 1) } : { db: file, suffix: "" };
}

// コードAPIで指定コード群のデータを取得（NEXTPOSITIONページング）。
async function fetchDataChunk(db, codes) {
  const merged = new Map();
  let startPosition = null, guard = 0;
  while (guard++ < 500) {
    const params = new URLSearchParams({ format: "json", lang: "jp", db, code: codes.join(","), startDate: START_DATE });
    if (startPosition != null) params.set("startPosition", String(startPosition));
    const json = JSON.parse(await httpsGetGzip(`${CODE_BASE}?${params.toString()}`));
    checkStatus(json, `getDataCode(${db})`);
    for (const s of findSeriesArray(json) || []) {
      const code = String(s.SERIES_CODE || "").trim();
      if (code) merged.set(code, s);
    }
    const next = getNextPosition(json);
    if (next == null) break;
    startPosition = next;
    await sleep(SLEEP_MS);
  }
  return merged;
}

// 1ファイル分（同一DB・同一期種の系列群）を取得してCSV出力する。
async function fetchFile(file, codes) {
  const { db, suffix } = splitFile(file);
  const got = new Map();
  for (let i = 0; i < codes.length; i += CODE_BATCH) {
    const chunk = codes.slice(i, i + CODE_BATCH);
    const m = await fetchDataChunk(db, chunk);
    for (const [k, v] of m) got.set(k, v);
    await sleep(SLEEP_MS);
  }

  const outCodes = [];
  const valueMaps = new Map();
  const allDates = new Set();
  const catalog = [];

  for (const code of codes) {
    const s = got.get(code);
    if (!s) continue;
    const { dates, values } = extractSeriesDV(s);
    const m = new Map();
    for (let i = 0; i < dates.length; i++) {
      const raw = values[i];
      if (raw == null || raw === "null" || raw === "") continue;
      const v = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(v)) continue;
      const d = normalizeDate(dates[i], s.FREQUENCY || suffix);
      m.set(d, v);
      allDates.add(d);
    }
    if (m.size === 0) continue;
    outCodes.push(code);
    valueMaps.set(code, m);
    catalog.push({
      file, code,
      name: String(s.NAME_OF_TIME_SERIES_J || "").trim(),
      unit: String(s.UNIT_J || "").trim(),
      freq: String(s.FREQUENCY || suffix).trim(),
    });
  }

  if (outCodes.length === 0) return { rows: 0, codes: 0, catalog: [] };

  const sortedDates = Array.from(allDates).sort();
  const lines = [["Date", ...outCodes].join(",")];
  for (const d of sortedDates) {
    const row = [d];
    for (const code of outCodes) { const m = valueMaps.get(code); row.push(m.has(d) ? m.get(d) : ""); }
    lines.push(row.map(csvEscape).join(","));
  }
  fs.writeFileSync(path.join(OUT_DIR, `${file}.csv`), lines.join("\n") + "\n", "utf8");
  return { rows: sortedDates.length, codes: outCodes.length, catalog };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const list = parseList(fs.readFileSync(LIST_FILE, "utf8"));
  if (list.length === 0) { console.error("bojlist.csv に有効な系列がありません。"); process.exit(1); }

  // ファイル単位にまとめる（順序を保持）
  const byFile = new Map();
  const aggByCode = new Map();
  for (const r of list) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    if (!byFile.get(r.file).includes(r.code)) byFile.get(r.file).push(r.code);
    aggByCode.set(r.file + "|" + r.code, r.agg === "sum" ? "sum" : "last");
  }

  console.log(`日銀API 政府統計の取得を開始します（startDate=${START_DATE}, ファイル数=${byFile.size}）`);
  const catalog = [];
  for (const [file, codes] of byFile) {
    try {
      const res = await fetchFile(file, codes);
      for (const c of res.catalog) c.agg = aggByCode.get(c.file + "|" + c.code) || "last";
      catalog.push(...res.catalog);
      console.log(`✅ ${file}: 系列${res.codes}/${codes.length} / 期間${res.rows}`);
    } catch (e) {
      console.error(`❌ エラー ${file}: ${e.message}`);
    }
    await sleep(SLEEP_MS);
  }

  const catHeader = ["file", "code", "name", "unit", "freq", "agg"];
  const catLines = [catHeader.join(",")];
  for (const c of catalog) catLines.push(catHeader.map((k) => csvEscape(c[k])).join(","));
  fs.writeFileSync(path.join(OUT_DIR, "_catalog.csv"), catLines.join("\n") + "\n", "utf8");
  console.log(`catalog: data/boj/_catalog.csv（系列 ${catalog.length}）`);
  console.log("すべての処理が完了しました。");
}

main();
