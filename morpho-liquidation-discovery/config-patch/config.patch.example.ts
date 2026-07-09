// 這不是可直接執行的檔案，是給你參考怎麼修改
// morpho-blue-liquidation-bot/apps/config/src/config.ts 的範例。
//
// 作法：在官方 config.ts 最上面加這段 import，
// 然後把每條鏈 options 裡的 additionalMarketsWhitelist
// 從寫死陣列改成呼叫這個 function。

import fs from "node:fs";
import path from "node:path";

// 指向跟 discovery 服務共用的 data 資料夾
// 建議用絕對路徑或環境變數，不要用相對路徑（兩個專案的工作目錄不同）
const DISCOVERY_DATA_DIR = process.env.WHITELIST_DATA_DIR ?? "/path/to/morpho-liquidation-discovery/data";

function loadApprovedMarketIds(chainId: number): `0x${string}`[] {
  const filePath = path.join(DISCOVERY_DATA_DIR, `discovered-markets.${chainId}.json`);
  if (!fs.existsSync(filePath)) return [];

  const markets: Array<{ marketId: string; approved: boolean }> = JSON.parse(
    fs.readFileSync(filePath, "utf-8"),
  );

  return markets.filter((m) => m.approved).map((m) => m.marketId as `0x${string}`);
}

// 使用範例（放進 config.ts 的 chainConfigs[base.id].options 裡）：
//
// additionalMarketsWhitelist: [
//   ...loadApprovedMarketIds(base.id),
//   // 你原本手動加的市場也可以繼續留在這裡
// ],
