/**
 * AaveAccountRegistry — discovers and tracks accounts that have interacted with Aave V3 Pool.
 *
 * Scans Supply / Borrow / Repay / Withdraw / LiquidationCall events to build a deduplicated
 * account list (does **not** watch LiquidationCall.liquidator — only the liquidated user).
 * Supports incremental scanning (only new blocks since last scan).
 *
 * Prefer offline `pnpm backfill:aave` (RPC or The Graph) for first-time history;
 * the bot only catches up from the durable checkpoint.
 *
 * Persistence (via BaseAccountRegistry):
 *   - `aave-accounts.<chainId>.json` — large accounts blob (infrequent)
 *   - `aave-accounts.<chainId>.checkpoint.json` — tiny block cursors (frequent)
 *
 * Pattern: mirrors CometAccountRegistry, adapted for Aave V3 event signatures.
 */
import { decodeEventLog, type AbiEvent, type Address } from "viem";
import { getLogs } from "viem/actions";

import { aaveEventAbi } from "./abis/AaveV3.js";
import { BaseAccountRegistry, sleep, type ScanClient } from "./utils/baseAccountRegistry.js";
import { hasPaidRpcConfigured } from "./utils/registryPaths.js";

// BUGFIX: 之前算出來後沒被使用，導致 getLogs 沒有任何事件篩選,等於每次都撈 Aave Pool
// 合約「所有」事件類型(包含高頻的 ReserveDataUpdated、Transfer 等),對這種高流量合約
// 負擔很重、更容易撞到 rate limit。現在真正拿去用(見下方 events 參數)。
// viem 的 getLogs 只接受 event/events,不支援原始 topics 參數;用 AbiEvent[] 型別放寬,
// 避免 aaveEventAbi 裡不同事件 indexed 參數數量不一致時 TS 型別推斷出錯。
const AAVE_ACTION_EVENTS = aaveEventAbi as readonly AbiEvent[];

/**
 * Default batch size for eth_getLogs.
 * - Explicit AAVE_SCAN_BATCH_SIZE wins
 * - Paid RPC: 5000 (Base public limit is often 10k; 5k is safer for dense Aave pools)
 * - Public RPC: 2000
 */
function resolveAaveScanBatchSize(): number {
  if (process.env.AAVE_SCAN_BATCH_SIZE !== undefined && process.env.AAVE_SCAN_BATCH_SIZE !== "") {
    const n = Number(process.env.AAVE_SCAN_BATCH_SIZE);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return hasPaidRpcConfigured() ? 5_000 : 2_000;
}

/**
 * Default delay between batches.
 * - Explicit AAVE_SCAN_DELAY_MS wins
 * - Paid RPC: 0 (rely on error backoff on rate limit)
 * - Public RPC: 50ms soft pacing (was 300ms — far too slow for multi-M block catch-up)
 */
function resolveAaveScanDelayMs(): number {
  if (process.env.AAVE_SCAN_DELAY_MS !== undefined && process.env.AAVE_SCAN_DELAY_MS !== "") {
    const n = Number(process.env.AAVE_SCAN_DELAY_MS);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return hasPaidRpcConfigured() ? 0 : 50;
}

const AAVE_SCAN_BATCH_SIZE = resolveAaveScanBatchSize();
const AAVE_SCAN_DELAY_MS = resolveAaveScanDelayMs();
/** Durable accounts flush during backfill (env override). */
const AAVE_ACCOUNTS_SAVE_INTERVAL = Number(process.env.AAVE_ACCOUNTS_SAVE_INTERVAL ?? 25_000);
/** Lightweight cursor flush interval (env override). */
const AAVE_CHECKPOINT_INTERVAL = Number(process.env.AAVE_CHECKPOINT_INTERVAL ?? 5_000);

export class AaveAccountRegistry extends BaseAccountRegistry {
  protected readonly logPrefix = "[AaveRegistry]";

  /** Aave Pool is high-traffic — batch/delay tuned via env + paid-RPC detection. */
  protected override get scanBatchSize(): number {
    return AAVE_SCAN_BATCH_SIZE;
  }

  protected override get scanDelayMs(): number {
    return AAVE_SCAN_DELAY_MS;
  }

  protected override get accountsSaveIntervalBlocks(): number {
    return Number.isFinite(AAVE_ACCOUNTS_SAVE_INTERVAL) && AAVE_ACCOUNTS_SAVE_INTERVAL > 0
      ? AAVE_ACCOUNTS_SAVE_INTERVAL
      : 25_000;
  }

  protected override get checkpointSaveIntervalBlocks(): number {
    return Number.isFinite(AAVE_CHECKPOINT_INTERVAL) && AAVE_CHECKPOINT_INTERVAL > 0
      ? AAVE_CHECKPOINT_INTERVAL
      : 5_000;
  }

  // initialScan / checkpointing inherited from BaseAccountRegistry:
  // mid-scan: tiny .checkpoint.json every ~5k blocks; accounts JSON every ~25k when dirty.

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
    const maxAttempts = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Only the 5 user-action events (not ReserveDataUpdated / Transfer noise).
        const logs = await getLogs(client, {
          address: poolAddress,
          events: AAVE_ACTION_EVENTS,
          fromBlock: BigInt(fromBlock),
          toBlock: BigInt(toBlock),
        });

        let newAccounts = 0;
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
            // Intentionally NOT tracking LiquidationCall.liquidator — bots/EOAs that only
            // liquidate never hold debt and bloat the watchlist (~hundreds of k noise).

            if (user) newAccounts += this.addAccount(poolAddress, user);
            if (onBehalfOf) newAccounts += this.addAccount(poolAddress, onBehalfOf);
            if (repayer) newAccounts += this.addAccount(poolAddress, repayer);
            if (to) newAccounts += this.addAccount(poolAddress, to);
          } catch {
            // Skip undecodable logs
          }
        }
        return newAccounts;
      } catch (e) {
        const err = e as { name?: string; message?: string; shortMessage?: string };
        const combined = [err.name, err.message, err.shortMessage].filter(Boolean).join(" ");
        const isTooLarge = /ResponseBodyTooLarge|response body.*exceed|size limit/i.test(combined);
        const isRateLimit = /rate limit|too many requests|429|-32016/i.test(combined);

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

        if (isRateLimit && attempt < maxAttempts - 1) {
          const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
          console.warn(
            `${logTag}Rate limited on blocks ${fromBlock}-${toBlock}, retry ${attempt + 1}/${maxAttempts - 1} in ${delayMs}ms`,
          );
          await sleep(delayMs);
          continue;
        }

        // Exhausted retries (or non-retryable): throw so initialScan does NOT advance the cursor past this gap.
        throw new Error(
          `Aave log scan failed for ${poolAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}: ${combined}`,
        );
      }
    }

    return 0;
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
