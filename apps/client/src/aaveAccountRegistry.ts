/**
 * AaveAccountRegistry — discovers and tracks accounts that have interacted with Aave V3 Pool.
 *
 * Scans Supply / Borrow / Repay / Withdraw / LiquidationCall events to build a deduplicated
 * account list. Supports incremental scanning (only new blocks since last scan).
 * Persists state to a local JSON file to avoid re-scanning from genesis on restart.
 *
 * Pattern: mirrors CometAccountRegistry, adapted for Aave V3 event signatures.
 */
import { decodeEventLog, type Address } from "viem";
import { getLogs } from "viem/actions";

import { aaveEventAbi } from "./abis/AaveV3.js";
import { BaseAccountRegistry, type ScanClient } from "./utils/baseAccountRegistry.js";

export class AaveAccountRegistry extends BaseAccountRegistry {
  protected readonly logPrefix = "[AaveRegistry]";

  protected async scanRange(
    client: ScanClient,
    poolAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number> {
    let newAccounts = 0;

    try {
      const logs = await getLogs(client, {
        address: poolAddress,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });

      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: aaveEventAbi,
            topics: log.topics,
            data: log.data,
          });
          const args = decoded.args as Record<string, unknown>;

          const user = args.user as Address | undefined;
          const onBehalfOf = args.onBehalfOf as Address | undefined;
          const repayer = args.repayer as Address | undefined;
          const to = args.to as Address | undefined;
          const liquidator = args.liquidator as Address | undefined;

          if (user) newAccounts += this.addAccount(poolAddress, user);
          if (onBehalfOf) newAccounts += this.addAccount(poolAddress, onBehalfOf);
          if (repayer) newAccounts += this.addAccount(poolAddress, repayer);
          if (to) newAccounts += this.addAccount(poolAddress, to);
          if (liquidator) newAccounts += this.addAccount(poolAddress, liquidator);
        } catch {
          // Skip undecodable logs
        }
      }
    } catch (e) {
      console.error(
        `${logTag}Aave log scan failed for ${poolAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}:`,
        e,
      );
    }

    return newAccounts;
  }

  /**
   * Remove an account from the registry (e.g., after full liquidation).
   */
  removeAccount(poolAddress: Address, account: Address): void {
    const poolKey = poolAddress.toLowerCase();
    const set = this.accounts.get(poolKey);
    if (set) {
      set.delete(account.toLowerCase() as Address);
    }
  }
}
