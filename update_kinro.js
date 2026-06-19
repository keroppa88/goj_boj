// 毎月勤労統計（統計コード 00450071）の現行月次データを取得する純Nodeスクリプト。
//
// 背景: 本統計は e-Stat 本体API(getStatsData)のDBが2016年で凍結しており使えない。
// そのため「長期時系列表 実数・指数累積データ」のファイル配信CSVを直接ダウンロードして使う。
//   一覧: https://www.e-stat.go.jp/stat-search/files?...&tclass2=000001144508 （4ファイル）
//   - 実数        : statInfId=000032189776 （現金給与総額[円], 所定外労働時間[時間] 等）
//   - 指数・伸び率: statInfId=000032189777 （実質賃金指数（現金給与総額）[2020=100] 等）
//   ダウンロードURL: https://www.e-stat.go.jp/stat-search/file-download?statInfId=XXXX&fileKind=1
//
// 取得対象（就業形態計・5人以上・調査産業計(TL)・月次・全国）:
//   現金給与総額（実数, 円）/ 実質賃金（実質賃金指数（現金給与総額）, 2020=100）/ 所定外労働時間（実数, 時間）
//
// CSVは Shift-JIS(cp932)。ただし数値・分類コードはASCII、カンマ(0x2C)はSJIS第2バイト域に
// 含まれないため latin1 として安全に行/列分割できる。種別(列0)の日本語のみバイト署名で照合する。
//
// 出力:
//   data/goj/kinro.csv      : Date,現金給与総額,実質賃金,所定外労働時間（YYYY-MM昇順）
//   data/goj/_catalog.csv   : 既存末尾に3行を追記（同名行は除去してから追記。無ければ作成）
//
// このサービスは政府統計総合窓口(e-Stat)のファイル配信を使用していますが、
// サービスの内容は国によって保証されたものではありません。

const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "data", "goj");
const KINRO_FILE = path.join(OUT_DIR, "kinro.csv");
const CATALOG_FILE = path.join(OUT_DIR, "_catalog.csv");

const STAT_INF_ID_REAL = "000032189776"; // 実数
const STAT_INF_ID_INDEX = "000032189777"; // 指数・伸び率

// 種別(列0)の Shift-JIS バイト署名
const SHU_JISSU = Buffer.from([0x8e, 0xc0, 0x90, 0x94]).toString("latin1"); // 実数
const SHU_SHISU = Buffer.from([0x8e, 0x77, 0x90, 0x94]).toString("latin1"); // 指数

const CATALOG_ROWS = [
  "現金給与総額,雇用・賃金,kinro,,円,毎月勤労統計(長期時系列・実数),last",
  "実質賃金,雇用・賃金,kinro,,2020=100,毎月勤労統計(実質賃金指数),last",
  "所定外労働時間,雇用・賃金,kinro,,時間,毎月勤労統計(長期時系列・実数),last",
];
const CATALOG_NAMES = ["現金給与総額", "実質賃金", "所定外労働時間"];

// e-Stat ファイル配信CSVをダウンロードして latin1 文字列で返す（バイト保持）。
function downloadCsv(statInfId, attempt = 1) {
  const url =
    "https://www.e-stat.go.jp/stat-search/file-download?statInfId=" +
    statInfId +
    "&fileKind=1";
  const MAX_ATTEMPTS = 5;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (kinro-fetch)",
          Accept: "text/csv,*/*",
        },
        timeout: 90000,
      },
      (res) => {
        // リダイレクト追従
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(
            downloadRedirect(res.headers.location, statInfId, attempt)
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (attempt < MAX_ATTEMPTS) {
            return setTimeout(
              () => resolve(downloadCsv(statInfId, attempt + 1)),
              3000
            );
          }
          return reject(
            new Error(`HTTP ${res.statusCode} for statInfId=${statInfId}`)
          );
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(Buffer.concat(chunks).toString("latin1"))
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      if (attempt < MAX_ATTEMPTS) {
        return setTimeout(
          () => resolve(downloadCsv(statInfId, attempt + 1)),
          3000
        );
      }
      reject(err);
    });
  });
}

function downloadRedirect(location, statInfId, attempt) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      location,
      { headers: { "User-Agent": "Mozilla/5.0 (kinro-fetch)" }, timeout: 90000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (attempt < 5)
            return setTimeout(
              () => resolve(downloadCsv(statInfId, attempt + 1)),
              3000
            );
          return reject(new Error(`HTTP ${res.statusCode} (redirect)`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// latin1 CSV をパース。カンマはSJIS多バイトに干渉しないので単純split可。
function parseRows(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => l.split(","));
}

// 月コードを YYYY-MM に正規化。'CY'(年計)等の非月次は null。
function toYM(year, month) {
  if (!/^\d{4}$/.test(year)) return null;
  if (!/^(0[1-9]|1[0-2])$/.test(month)) return null; // 01..12 のみ
  return `${year}-${month}`;
}

async function main() {
  // --- 実数ファイル: 現金給与総額[円], 所定外労働時間[時間] ---
  console.log(`実数CSVをダウンロード中 (statInfId=${STAT_INF_ID_REAL}) ...`);
  const realRows = parseRows(await downloadCsv(STAT_INF_ID_REAL));
  // 列: 種別,年,月,産業分類,規模,就業形態,現金給与総額,...,所定外労働時間,...
  const COL = {
    shubetsu: 0,
    year: 1,
    month: 2,
    industry: 3,
    size: 4,
    employ: 5,
    cash: 6, // 現金給与総額
    overtimeHours: 13, // 所定外労働時間（実数ヘッダ位置）
  };

  const cash = new Map(); // YYYY-MM -> 現金給与総額
  const overtime = new Map(); // YYYY-MM -> 所定外労働時間
  for (const r of realRows) {
    if (r[COL.shubetsu] !== SHU_JISSU) continue;
    if (r[COL.industry].trim() !== "TL") continue; // 調査産業計
    if (r[COL.size] !== "T") continue; // 5人以上（規模コード T=総計5人以上。'0'は30人以上）
    if (r[COL.employ] !== "0") continue; // 就業形態計
    const ym = toYM(r[COL.year], r[COL.month]);
    if (!ym) continue;
    const c = r[COL.cash];
    const o = r[COL.overtimeHours];
    if (c !== undefined && c !== "") cash.set(ym, c);
    if (o !== undefined && o !== "") overtime.set(ym, o);
  }

  // --- 指数ファイル: 実質賃金指数（現金給与総額）[2020=100] ---
  console.log(`指数CSVをダウンロード中 (statInfId=${STAT_INF_ID_INDEX}) ...`);
  const idxRows = parseRows(await downloadCsv(STAT_INF_ID_INDEX));
  // 列: 種別,年,月,産業分類,規模,就業形態,...,実質賃金指数（現金給与総額）(列11),...
  const ICOL = {
    shubetsu: 0,
    year: 1,
    month: 2,
    industry: 3,
    size: 4,
    employ: 5,
    realWage: 11, // 実質賃金指数（現金給与総額）
  };
  // 規模コードは実数ファイルと同じ規約。T=5人以上（総計）、0=30人以上。
  const realWage = new Map(); // YYYY-MM -> 実質賃金指数
  for (const r of idxRows) {
    if (r[ICOL.shubetsu] !== SHU_SHISU) continue; // 種別=指数
    if (r[ICOL.industry].trim() !== "TL") continue;
    if (r[ICOL.size] !== "T") continue; // 5人以上
    if (r[ICOL.employ] !== "0") continue; // 就業形態計
    const ym = toYM(r[ICOL.year], r[ICOL.month]);
    if (!ym) continue;
    const v = r[ICOL.realWage];
    if (v !== undefined && v !== "") realWage.set(ym, v);
  }

  // --- マージして kinro.csv 出力 ---
  const allYM = new Set([
    ...cash.keys(),
    ...realWage.keys(),
    ...overtime.keys(),
  ]);
  const ymList = [...allYM].sort();
  const lines = ["Date,現金給与総額,実質賃金,所定外労働時間"];
  for (const ym of ymList) {
    lines.push(
      [
        ym,
        cash.get(ym) ?? "",
        realWage.get(ym) ?? "",
        overtime.get(ym) ?? "",
      ].join(",")
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(KINRO_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(
    `kinro.csv を出力: ${ymList.length} 行 (${ymList[0]} 〜 ${
      ymList[ymList.length - 1]
    })`
  );

  // --- _catalog.csv へ追記（同名行を除去してから追記）---
  updateCatalog();

  // --- 検証ログ ---
  const last = ymList[ymList.length - 1];
  console.log("直近月", last, {
    現金給与総額: cash.get(last),
    実質賃金: realWage.get(last),
    所定外労働時間: overtime.get(last),
  });
}

function updateCatalog() {
  const header = "name,cat,file,statsDataId,unit,table,agg";
  let existing = [];
  if (fs.existsSync(CATALOG_FILE)) {
    existing = fs
      .readFileSync(CATALOG_FILE, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
  }
  let head = header;
  let body = existing;
  if (existing.length && existing[0].startsWith("name,")) {
    head = existing[0];
    body = existing.slice(1);
  }
  // 同名(kinroの3系列)の既存行を除去してから追記し、重複追記を防ぐ
  body = body.filter((l) => {
    const name = l.split(",")[0];
    return !CATALOG_NAMES.includes(name);
  });
  const out = [head, ...body, ...CATALOG_ROWS];
  fs.writeFileSync(CATALOG_FILE, out.join("\n") + "\n", "utf-8");
  console.log(`_catalog.csv に kinro 3系列を追記`);
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
