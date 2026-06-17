// e-Stat 本体API getStatsList で統計表IDを検索する補助ツール。
// gojlist.csv に書く「統計表ID(statsDataId)」を探すために使う。
//
// 使い方:
//   ESTAT_APPID=xxxx node search_goj.js "消費者物価指数"
//   ESTAT_APPID=xxxx node search_goj.js "消費者物価指数 総合 月次"   ← スペース区切りでAND検索
//
// 出力: 統計表ID / 統計表名 / 調査名 / 提供統計 / 公開日 を一覧表示する。
// 目的の表のIDを gojlist.csv の「統計表ID」列に記入してください。

const https = require("https");

const HOST = "api.e-stat.go.jp";
const BASE = "/rest/3.0/app/json/getStatsList";
const APP_ID = process.env.ESTAT_APPID || "";
const LIMIT = process.env.GOJ_SEARCH_LIMIT || "30";

function httpsGetJson(pathWithQuery) {
  return new Promise((resolve, reject) => {
    https.get(
      { host: HOST, path: pathWithQuery, headers: { "User-Agent": "goj_boj-estat/1.0", "Accept": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`JSON parse失敗: ${e.message}`)); }
        });
      }
    ).on("error", reject);
  });
}

function asArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
function txt(v) { return v == null ? "" : String(v.$ != null ? v.$ : v).trim(); }

async function main() {
  if (!APP_ID) { console.error("環境変数 ESTAT_APPID（e-StatアプリケーションID）を設定してください。"); process.exit(1); }
  const word = process.argv.slice(2).join(" ").trim();
  if (!word) { console.error('検索語を指定してください。例: node search_goj.js "消費者物価指数 総合"'); process.exit(1); }

  const params = new URLSearchParams({ appId: APP_ID, searchWord: word, limit: LIMIT, statsField: "" });
  const json = await httpsGetJson(`${BASE}?${params.toString()}`);
  const gl = json && json.GET_STATS_LIST;
  const result = gl && gl.RESULT;
  if (!result || String(result.STATUS) !== "0") {
    throw new Error(`getStatsList STATUS ${result ? result.STATUS : "?"}: ${result ? (result.ERROR_MSG || "").trim() : "no RESULT"}`);
  }
  const tables = asArray(gl.DATALIST_INF && gl.DATALIST_INF.TABLE_INF);
  console.log(`検索語「${word}」: ${tables.length}件（最大${LIMIT}件表示）\n`);
  for (const t of tables) {
    const id = t["@id"];
    const title = txt(t.TITLE) || txt(t.STATISTICS_NAME);
    const statName = txt(t.STAT_NAME);
    const cycle = txt(t.SURVEY_DATE) || txt(t.CYCLE);
    const open = txt(t.OPEN_DATE);
    console.log(`ID: ${id}`);
    console.log(`  表名: ${title}`);
    console.log(`  統計: ${statName}  周期/調査時: ${cycle}  公開: ${open}`);
    console.log("");
  }
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
