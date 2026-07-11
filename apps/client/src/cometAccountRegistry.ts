/**
 * CometAccountRegistry — discovers and tracks accounts that have interacted with Compound V3 Comets.
 *
 * Scans SupplyCollateral / WithdrawCollateral / AbsorbDebt events to build a deduplicated
 * account list per Comet. Supports incremental scanning (only new blocks since last scan).
 * Persists state to a local JSON file to avoid re-scanning from genesis on restart.
 */
import { decodeEventLog, type Address } from "viem";
import { getLogs } from "viem/actions";

import { cometEventAbi } from "./abis/Comet.js";
import { BaseAccountRegistry, isRateLimitError, sleep, type ScanClient } from "./utils/baseAccountRegistry.js";

export class CometAccountRegistry extends BaseAccountRegistry {
  protected readonly logPrefix = "[CometRegistry]";

  protected async scanRange(
    client: ScanClient,
    cometAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number> {
    let newAccounts = 0;

    const narrowFilter = () =>
      getLogs(client, {
        address: cometAddress,
        event: {
          inputs: [
            { indexed: true, name: "src", type: "address" },
            { indexed: true, name: "dst", type: "address" },
            { indexed: true, name: "asset", type: "address" },
            { indexed: false, name: "amount", type: "uint256" },
          ],
          name: "SupplyCollateral",
          type: "event",
        },
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        strict: false,
      });

    let logs: Awaited<ReturnType<typeof narrowFilter>> | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        logs = await narrowFilter();
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        if (isRateLimitError(e) && attempt < 3) {
          const delayMs = 1000 * 2 ** attempt;
          console.warn(
            `${logTag}Rate limited scanning ${cometAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}, retrying in ${delayMs}ms (attempt ${attempt + 1}/3)`,
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
            abi: cometEventAbi,
            topics: log.topics,
            data: log.data,
          });
          const args = decoded.args as Record<string, unknown>;
          const dst = args.dst as Address | undefined;
          const src = args.src as Address | undefined;

          if (dst) newAccounts += this.addAccount(cometAddress, dst);
          if (src) newAccounts += this.addAccount(cometAddress, src);
        } catch {
          // Skip undecodable logs
        }
      }
      return newAccounts;
    }

    console.warn(
      `${logTag}Event filter failed for ${cometAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}, trying broad filter (${lastError instanceof Error ? lastError.message : lastError})`,
    );
    try {
      const broadLogs = await getLogs(client, {
        address: cometAddress,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });

      for (const log of broadLogs) {
        try {
          const decoded = decodeEventLog({
            abi: cometEventAbi,
            topics: log.topics,
            data: log.data,
          });
          const args = decoded.args as Record<string, unknown>;
          const dst = args.dst as Address | undefined;
          const src = args.src as Address | undefined;
          const borrower = args.borrower as Address | undefined;

          if (dst) newAccounts += this.addAccount(cometAddress, dst);
          if (src) newAccounts += this.addAccount(cometAddress, src);
          if (borrower) newAccounts += this.addAccount(cometAddress, borrower);
        } catch {
          // Skip undecodable logs
        }
      }
    } catch (e2) {
      console.error(
        `${logTag}Broad log scan failed for ${cometAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}:`,
        e2,
      );
    }

    return newAccounts;
  }
}
