import { type Address } from "viem";

const QUERY = `
  query FetchWhitelistedVaults($chainIds: [Int!]!) {
    vaults(where: { chainId_in: $chainIds, listed: true }) {
      items {
        address
        chain {
          id
        }
      }
    }
  }
`;

interface VaultsResponse {
  data: {
    vaults: {
      items: { address: Address }[];
    };
  };
  errors?: { message: string }[];
}

export async function fetchWhitelistedVaults(chainId: number): Promise<Address[]> {
  // SECURITY (NM2): 添加 timeout 和重試機制
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 10_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, TIMEOUT_MS);

      const res = await fetch("https://blue-api.morpho.org/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { chainIds: [chainId] } }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const json = (await res.json()) as VaultsResponse;

      if (json.errors?.length) {
        console.warn(json.errors.map((e) => e.message).join("\n"));
        return [];
      }

      // SECURITY (NM2): 檢查空結果並警告
      const items = json.data?.vaults?.items ?? [];
      if (items.length === 0) {
        console.warn(
          `[fetchWhitelistedVaults] ⚠️ chainId=${chainId} 返回 0 個 vault，` +
            `可能是 API 異常或確實無 vault`,
        );
      }

      return items.map((item) => item.address);
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[fetchWhitelistedVaults] 嘗試 ${attempt + 1} 失敗，重試...`,
          (e as Error).message,
        );
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // 退避
        continue;
      }
      console.error(`[fetchWhitelistedVaults] 所有重試失敗:`, (e as Error).message);
      return [];
    }
  }
  return [];
}
