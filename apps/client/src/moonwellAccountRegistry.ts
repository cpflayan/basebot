/**
 * MoonwellAccountRegistry — discovers and tracks accounts that have interacted with Moonwell (Compound V2) mTokens.
 *
 * Scans Borrow / Mint / RepayBorrow / LiquidateBorrow events to build a deduplicated
 * account list per mToken. Supports incremental scanning (only new blocks since last scan).
 * Persists state to a local JSON file to avoid re-scanning from genesis on restart.
 *
 * Key difference from CometAccountRegistry:
 *   - Compound V2 events are per-mToken (not per-Comet)
 *   - We track borrowers (accounts with debt) since only they can be liquidated
 *   - LiquidateBorrow events help identify already-liquidated accounts
 */
import { decodeEventLog, type Address } from "viem";
import { getLogs } from "viem/actions";

import { mTokenEventAbi } from "./abis/Moonwell.js";
import { BaseAccountRegistry, isRateLimitError, sleep, type ScanClient } from "./utils/baseAccountRegistry.js";

export class MoonwellAccountRegistry extends BaseAccountRegistry {
  protected readonly logPrefix = "[MoonwellRegistry]";

  protected async scanRange(
    client: ScanClient,
    mTokenAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number> {
    let newAccounts = 0;

    const narrowFilter = () =>
      getLogs(client, {
        address: mTokenAddress,
        event: {
          inputs: [
            { indexed: false, name: "borrower", type: "address" },
            { indexed: false, name: "borrowAmount", type: "uint256" },
            { indexed: false, name: "accountBorrows", type: "uint256" },
            { indexed: false, name: "totalBorrows", type: "uint256" },
          ],
          name: "Borrow",
          type: "event",
        },
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        strict: false,
      });

    let logs: Awaited<ReturnType<typeof narrowFilter>> | undefined;
    let lastError: unknown;

    // 先試窄篩選;如果是 rate limit,延遲後重試同一個窄篩選最多 3 次,
    // 而不是立刻換成更重的 broad filter(那只會被限速得更兇)。
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        logs = await narrowFilter();
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        if (isRateLimitError(e) && attempt < 3) {
          const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
          console.warn(
            `${logTag}Rate limited scanning ${mTokenAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}, retrying in ${delayMs}ms (attempt ${attempt + 1}/3)`,
          );
          await sleep(delayMs);
          continue;
        }
        break;
      }
    }

    if (logs) {
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: mTokenEventAbi,
            topics: log.topics,
            data: log.data,
          });
          const args = decoded.args as Record<string, unknown>;

          if (decoded.eventName === "Borrow") {
            const borrower = args.borrower as Address | undefined;
            if (borrower) newAccounts += this.addAccount(mTokenAddress, borrower);
          } else if (decoded.eventName === "LiquidateBorrow") {
            const borrower = args.borrower as Address | undefined;
            if (borrower) newAccounts += this.addAccount(mTokenAddress, borrower);
          }
        } catch {
          // Skip undecodable logs
        }
      }
      return newAccounts;
    }

    // 窄篩選重試後仍失敗,且不是 rate limit(例如節點不支援該篩選格式)才降級成 broad filter。
    console.warn(
      `${logTag}Event filter failed for ${mTokenAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}, trying broad filter (${lastError instanceof Error ? lastError.message : lastError})`,
    );
    try {
      const broadLogs = await getLogs(client, {
        address: mTokenAddress,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });

      for (const log of broadLogs) {
        try {
          const decoded = decodeEventLog({
            abi: mTokenEventAbi,
            topics: log.topics,
            data: log.data,
          });
          const args = decoded.args as Record<string, unknown>;
          const borrower = args.borrower as Address | undefined;
          const minter = args.minter as Address | undefined;
          const payer = args.payer as Address | undefined;

          if (borrower) newAccounts += this.addAccount(mTokenAddress, borrower);
          if (minter) newAccounts += this.addAccount(mTokenAddress, minter);
          if (payer) newAccounts += this.addAccount(mTokenAddress, payer);
        } catch {
          // Skip undecodable logs
        }
      }
    } catch (e2) {
      console.error(
        `${logTag}Broad log scan failed for ${mTokenAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}:`,
        e2,
      );
    }

    return newAccounts;
  }
}
