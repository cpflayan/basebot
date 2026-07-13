/**
 * External account sources for Aave V3 discovery (avoids multi-million-block eth_getLogs).
 *
 * Primary: official Aave Protocol subgraph on The Graph decentralized network.
 * Auth (The Graph gateway, recommended):
 *   POST https://gateway.thegraph.com/api/subgraphs/id/<SUBGRAPH_ID>
 *   Authorization: Bearer <THEGRAPH_API_KEY>
 *
 * Also supports legacy path-key URL via AAVE_SUBGRAPH_URL override.
 *
 * @see https://github.com/aave/protocol-subgraphs
 */
import type { Address } from "viem";

/** Official Aave V3 protocol subgraph IDs (The Graph decentralized network). */
export const AAVE_V3_SUBGRAPH_IDS: Record<number, string> = {
  // Base V3 — https://thegraph.com/explorer/subgraphs/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF
  8453: "GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
  // Ethereum Mainnet V3
  1: "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
};

export interface AaveSubgraphBorrowersResult {
  accounts: Address[];
  /** Indexed block height from `_meta.block.number` (use as durable checkpoint). */
  blockNumber: number;
  sourceUrl: string;
}

export interface ResolvedAaveSubgraphEndpoint {
  /** Gateway URL (no secrets in path when using Bearer auth). */
  url: string;
  /** Optional Authorization header value, e.g. `Bearer xxx`. */
  authorization?: string;
}

/**
 * Resolve gateway URL + auth for a chain.
 *
 * Preferred: THEGRAPH_API_KEY → Bearer on
 *   https://gateway.thegraph.com/api/subgraphs/id/<id>
 *
 * Override: AAVE_SUBGRAPH_URL (full URL; still sends Bearer if THEGRAPH_API_KEY set)
 */
export function resolveAaveSubgraphEndpoint(
  chainId: number,
): ResolvedAaveSubgraphEndpoint | undefined {
  const apiKey = process.env.THEGRAPH_API_KEY?.trim();
  const override = process.env.AAVE_SUBGRAPH_URL?.trim();

  if (override) {
    return {
      url: override,
      authorization: apiKey ? `Bearer ${apiKey}` : undefined,
    };
  }

  const subgraphId = AAVE_V3_SUBGRAPH_IDS[chainId];
  if (!subgraphId || !apiKey) return undefined;

  // Official gateway style (key NOT in path)
  return {
    url: `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`,
    authorization: `Bearer ${apiKey}`,
  };
}

/** @deprecated Prefer resolveAaveSubgraphEndpoint — kept for callers that only need a URL check. */
export function resolveAaveSubgraphUrl(chainId: number): string | undefined {
  return resolveAaveSubgraphEndpoint(chainId)?.url;
}

interface GraphUserReserve {
  id: string;
  user: { id: string };
}

interface GraphResponse {
  data?: {
    _meta?: { block?: { number?: number } };
    userReserves?: GraphUserReserve[];
  };
  errors?: { message: string }[];
}

/**
 * Page through userReserves with outstanding debt (currentTotalDebt > 0).
 * These are the only accounts that can become liquidatable — pure suppliers/liquidators excluded.
 *
 * Note: sample Studio queries like `protocols { pools }` are often Messari schema,
 * not the official Aave protocol subgraph (which uses userReserves / users / reserves).
 */
export async function fetchAaveBorrowersFromSubgraph(
  chainId: number,
  options?: {
    subgraphUrl?: string;
    pageSize?: number;
    logTag?: string;
    /** Abort after this many pages (safety). Default: unlimited. */
    maxPages?: number;
  },
): Promise<AaveSubgraphBorrowersResult> {
  const endpoint = options?.subgraphUrl
    ? {
        url: options.subgraphUrl,
        authorization: process.env.THEGRAPH_API_KEY?.trim()
          ? `Bearer ${process.env.THEGRAPH_API_KEY.trim()}`
          : undefined,
      }
    : resolveAaveSubgraphEndpoint(chainId);

  if (!endpoint) {
    throw new Error(
      `No Aave subgraph endpoint for chain ${chainId}. Set THEGRAPH_API_KEY or AAVE_SUBGRAPH_URL.`,
    );
  }

  const { url, authorization } = endpoint;
  const pageSize = options?.pageSize ?? 1000;
  const logTag = options?.logTag ?? "[AaveSubgraph] ";
  const maxPages = options?.maxPages ?? Number.POSITIVE_INFINITY;

  const accounts = new Set<string>();
  let lastId = "";
  let blockNumber = 0;
  let page = 0;

  while (page < maxPages) {
    page += 1;
    const where = lastId
      ? `{ currentTotalDebt_gt: "0", id_gt: "${lastId}" }`
      : `{ currentTotalDebt_gt: "0" }`;

    // Official Aave protocol subgraph entities (not protocols/contractToPoolMappings)
    const query = `{
      _meta { block { number } }
      userReserves(first: ${pageSize}, where: ${where}, orderBy: id, orderDirection: asc) {
        id
        user { id }
      }
    }`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authorization) {
      headers.Authorization = authorization;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Aave subgraph HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as GraphResponse;
    if (json.errors?.length) {
      throw new Error(
        `Aave subgraph GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const metaBlock = json.data?._meta?.block?.number;
    if (typeof metaBlock === "number") blockNumber = metaBlock;

    const rows = json.data?.userReserves ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const id = row.user?.id?.toLowerCase();
      if (id?.startsWith("0x")) accounts.add(id);
      lastId = row.id;
    }

    if (page === 1 || page % 10 === 0) {
      console.log(
        `${logTag}subgraph page ${page}: +${rows.length} userReserves, ${accounts.size} unique borrowers (block ${blockNumber})`,
      );
    }

    if (rows.length < pageSize) break;
  }

  return {
    accounts: [...accounts] as Address[],
    blockNumber,
    // URL has no secret when using Bearer; still redact query-ish fragments
    sourceUrl: url.replace(/\/api\/[0-9a-fA-F-]{8,}\//, "/api/***/"),
  };
}

export function canUseAaveSubgraph(chainId: number): boolean {
  return Boolean(resolveAaveSubgraphEndpoint(chainId));
}
