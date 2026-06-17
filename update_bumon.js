//投資部門別売買状況を取得する。
//取得情報をdataフォルダのcsvに上書きする設定。

const https = require("https");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.JQUANTS_API_KEY;
const OUT_DIR = path.join(__dirname, "data");

const SECTIONS = process.env.JQUANTS_TRADE_SECTIONS
  ? process.env.JQUANTS_TRADE_SECTIONS.split(",").map((s) => s.trim()).filter(Boolean)
  : ["TSEPrime"];

// ●データ取得期間
const FROM_DATE = process.env.JQUANTS_TRADE_FROM || "2022-01-01";

// YYYY-MM-DD 形式で今日の日付を生成
const today = new Date().toISOString().slice(0, 10);

// TO_DATE を「本日」にする
const TO_DATE = process.env.JQUANTS_TRADE_TO || today;

if (!API_KEY || API_KEY === "○○") {
  console.error("❌ 環境変数 JQUANTS_API_KEY（またはコード内 API_KEY）を設定してください。");
  process.exit(1);
}
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// あなたの提示ヘッダー順（v2短縮名）
const FIELDS = [
  "PubDate","StDate","EnDate","Section",
  "PropSell","PropBuy","PropTot","PropBal",
  "BrkSell","BrkBuy","BrkTot","BrkBal",
  "TotSell","TotBuy","TotTot","TotBal",
  "IndSell","IndBuy","IndTot","IndBal",
  "FrgnSell","FrgnBuy","FrgnTot","FrgnBal",
  "SecCoSell","SecCoBuy","SecCoTot","SecCoBal",
  "InvTrSell","InvTrBuy","InvTrTot","InvTrBal",
  "BusCoSell","BusCoBuy","BusCoTot","BusCoBal",
  "OthCoSell","OthCoBuy","OthCoTot","OthCoBal",
  "InsCoSell","InsCoBuy","InsCoTot","InsCoBal",
  "BankSell","BankBuy","BankTot","BankBal",
  "TrstBnkSell","TrstBnkBuy","TrstBnkTot","TrstBnkBal",
  "OthFinSell","OthFinBuy","OthFinTot","OthFinBal",
];

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  const header = FIELDS.join(",");
  const body = rows
    .map((r) => FIELDS.map((f) => csvEscape(r?.[f] ?? "")).join(","))
    .join("\n");
  return header + "\n" + body + "\n";
}

function httpsGetJson({ pathWithQuery }) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: "api.jquants.com",
          path: pathWithQuery,
          method: "GET",
          headers: { "x-api-key": API_KEY },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`JSON parse error: ${e.message} body=${data.slice(0, 300)}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode} ${data}`));
            }
          });
        }
      )
      .on("error", reject);
  });
}

async function fetchInvestorTypes({ section, from, to }) {
  const all = [];
  let paginationKey = "";

  while (true) {
    const params = new URLSearchParams();
    if (section) params.set("section", section);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (paginationKey) params.set("pagination_key", paginationKey);

    const json = await httpsGetJson({
      pathWithQuery: `/v2/equities/investor-types?${params.toString()}`,
    });

    all.push(...(json.data ?? []));
    paginationKey = json.pagination_key || "";
    if (!paginationKey) break;
  }

  return all;
}

async function main() {
  console.log("投資部門別売買状況（v2 investor-types）の取得を開始します...");
  console.log(`FROM=${FROM_DATE} TO=${TO_DATE} sections=${SECTIONS.join(",")}`);
  console.log("---");

  for (const section of SECTIONS) {
    try {
      const rows = await fetchInvestorTypes({ section, from: FROM_DATE, to: TO_DATE });

      const filePath = path.join(OUT_DIR, `${section}.csv`);
      fs.writeFileSync(filePath, buildCsv(rows), "utf8");

      console.log(`✅ 成功: ${section}.csv (${rows.length}件)`);
    } catch (e) {
      console.error(`❌ エラー ${section}: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("すべての処理が完了しました。");
}

main();
