/**
 * AaveAccountRegistry — discovers and tracks accounts that have interacted with Aave V3 Pool.
 *
 * Scans Supply / Borrow / Repay / Withdraw / LiquidationCall events to build a deduplicated
 * account list. Supports incremental scanning (only new blocks since last scan).
 * Persists state to a local JSON file to avoid re-scanning from genesis on restart.
 *
 * Pattern: mirrors CometAccountRegistry, adapted for Aave V3 event signatures.
 */
import { decodeEventLog, type AbiEvent, type Address } from "viem";
import { getLogs } from "viem/actions";

import { aaveEventAbi } from "./abis/AaveV3.js";
import { BaseAccountRegistry, type ScanClient } from "./utils/baseAccountRegistry.js";

// BUGFIX: 之前算出來後沒被使用，導致 getLogs 沒有任何事件篩選,等於每次都撈 Aave Pool
// 合約「所有」事件類型(包含高頻的 ReserveDataUpdated、Transfer 等),對這種高流量合約
// 負擔很重、更容易撞到 rate limit。現在真正拿去用(見下方 events 參數)。
// viem 的 getLogs 只接受 event/events,不支援原始 topics 參數;用 AbiEvent[] 型別放寬,
// 避免 aaveEventAbi 裡不同事件 indexed 參數數量不一致時 TS 型別推斷出錯。
const AAVE_ACTION_EVENTS = aaveEventAbi as readonly AbiEvent[];
const AAVE_SCAN_BATCH_SIZE = Number(process.env.AAVE_SCAN_BATCH_SIZE ?? 100);
const AAVE_SCAN_DELAY_MS = Number(process.env.AAVE_SCAN_DELAY_MS ?? 300);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AaveAccountRegistry extends BaseAccountRegistry {
  protected readonly logPrefix = "[AaveRegistry]";

  async initialScan(
    client: ScanClient,
    contractAddress: Address,
    deployBlock: number,
    logTag: string,
    scanClient?: ScanClient,
  ): Promise<void> {
    const rpcClient = scanClient ?? client;
    const key = contractAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(key) ?? 0;
    const fromBlock = Math.max(deployBlock, lastScanned + 1);

    const { getBlockNumber } = await import("viem/actions");
    const currentBlock = Number(await getBlockNumber(rpcClient));
    console.log(
      `${logTag}🔍 Scanning ${contractAddress.slice(0, 10)}... from block ${fromBlock} to ${currentBlock}`,
    );

    let scanned = 0;
    for (let start = fromBlock; start <= currentBlock; start += AAVE_SCAN_BATCH_SIZE) {
      const end = Math.min(start + AAVE_SCAN_BATCH_SIZE - 1, currentBlock);
      await this.scanRange(rpcClient, contractAddress, start, end, logTag);
      scanned += end - start + 1;
      if (AAVE_SCAN_DELAY_MS > 0) await sleep(AAVE_SCAN_DELAY_MS);
    }

    this.lastScannedBlock.set(key, currentBlock);
    this.saveToFile();

    const count = this.accounts.get(key)?.size ?? 0;
    console.log(
      `${logTag}✅ Scan complete: ${scanned} blocks scanned, ${count} unique accounts found`,
    );
  }

  protected async scanRange(
    client: ScanClient,
    poolAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number> {
    return this.scanRangeWithSize(
      client,
      poolAddress,
      fromBlock,
      toBlock,
      logTag,
      toBlock - fromBlock + 1,
    );
  }

  private async scanRangeWithSize(
    client: ScanClient,
    poolAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
    _batchSize: number,
  ): Promise<number> {
    let newAccounts = 0;

    try {
      // BUGFIX: USER_ACTION_TOPICS 之前算出來後沒被使用，導致這裡沒有 topic 篩選,
      // 等於每次都撈 Aave Pool 合約「所有」事件類型(包含高頻的 ReserveDataUpdated、
      // Transfer 等),對這種高流量合約來說負擔很重、更容易撞到 rate limit。
      // 現在改成只篩選我們真正關心的 5 種事件(Supply/Borrow/Repay/Withdraw/LiquidationCall)。
      const logs = await getLogs(client, {
        address: poolAddress,
        events: AAVE_ACTION_EVENTS,
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
      const err = e as { name?: string; message?: string; shortMessage?: string };
      const combined = [err.name, err.message, err.shortMessage].filter(Boolean).join(" ");
      const isTooLarge = /ResponseBodyTooLarge|response body.*exceed|size limit/i.test(combined);
      const isRateLimit = /rate limit|too many requests|429/i.test(combined);

      if (isTooLarge && toBlock - fromBlock > 50) {
        const mid = Math.floor((fromBlock + toBlock) / 2);
        console.warn(
          `${logTag}Response too large for blocks ${fromBlock}-${toBlock}, splitting in half`,
        );
        const a = await this.scanRangeWithSize(
          client,
          poolAddress,
          fromBlock,
          mid,
          logTag,
          mid - fromBlock + 1,
        );
        const b = await this.scanRangeWithSize(
          client,
          poolAddress,
          mid + 1,
          toBlock,
          logTag,
          toBlock - mid,
        );
        return a + b;
      }

      if (isRateLimit) {
        console.warn(`${logTag}Rate limited on blocks ${fromBlock}-${toBlock}, backing off 5s`);
        await sleep(5000);
      } else {
        console.error(
          `${logTag}Aave log scan failed for ${poolAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}: ${combined}`,
        );
      }
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
