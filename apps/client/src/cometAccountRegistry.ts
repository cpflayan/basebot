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
import { BaseAccountRegistry, type ScanClient } from "./utils/baseAccountRegistry.js";

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

    try {
      const logs = await getLogs(client, {
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
    } catch {
      console.warn(
        `${logTag}Event filter failed for ${cometAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}, trying broad filter`,
      );
      try {
        const logs = await getLogs(client, {
          address: cometAddress,
          fromBlock: BigInt(fromBlock),
          toBlock: BigInt(toBlock),
        });

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
    }

    return newAccounts;
  }
}
