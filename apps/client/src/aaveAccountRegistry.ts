/**
 * AaveAccountRegistry — discovers and tracks accounts that have interacted with Aave V3 Pool.
 *
 * Scans Supply / Borrow / Repay / Withdraw / LiquidationCall events to build a deduplicated
 * account list. Supports incremental scanning (only new blocks since last scan).
 * Persists state to a local JSON file to avoid re-scanning from genesis on restart.
 *
 * Pattern: mirrors CometAccountRegistry, adapted for Aave V3 event signatures.
 */
import fs from "node:fs";
import path from "node:path";

import {
  decodeEventLog,
  type Address,
  type Transport,
  type Chain,
  type Account,
  type Client,
  type WalletClient,
} from "viem";
import { getLogs, getBlockNumber } from "viem/actions";

import { aaveEventAbi } from "./abis/AaveV3.js";

/** Max blocks per eth_getLogs call — Base 公開 RPC 上限 10,000 */
const SCAN_BATCH_SIZE = 10_000;

/** Generic client type for read-only scanning */
type ScanClient = Client<Transport, Chain> | WalletClient<Transport, Chain, Account>;

interface RegistryState {
  /** poolAddress (lowercase) → array of unique account addresses */
  accounts: Record<string, string[]>;
  /** poolAddress (lowercase) → last scanned block number */
  lastScannedBlock: Record<string, number>;
}

export class AaveAccountRegistry {
  /** poolAddress (lowercase) → Set<account (lowercase)> */
  private accounts = new Map<string, Set<Address>>();
  /** poolAddress (lowercase) → last scanned block */
  private lastScannedBlock = new Map<string, number>();
  /** Path for JSON persistence */
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // ─── Persistence ───

  loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as RegistryState;
      for (const [pool, addrs] of Object.entries(raw.accounts ?? {})) {
        this.accounts.set(pool, new Set(addrs as Address[]));
      }
      for (const [pool, block] of Object.entries(raw.lastScannedBlock ?? {})) {
        this.lastScannedBlock.set(pool, block);
      }
      const total = [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
      console.log(`[AaveRegistry] Loaded ${total} accounts from ${this.filePath}`);
    } catch (e) {
      console.error(`[AaveRegistry] Failed to load from ${this.filePath}:`, e);
    }
  }

  saveToFile(): void {
    const dir = path.dirname(this.filePath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const state: RegistryState = {
      accounts: {},
      lastScannedBlock: {},
    };
    for (const [pool, set] of this.accounts) {
      state.accounts[pool] = [...set];
    }
    for (const [pool, block] of this.lastScannedBlock) {
      state.lastScannedBlock[pool] = block;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  // ─── Scanning ───

  /**
   * Initial scan: scan from deployBlock to current block for the Aave V3 Pool.
   * Processes in batches of SCAN_BATCH_SIZE to avoid RPC limits.
   */
  async initialScan(
    client: ScanClient,
    poolAddress: Address,
    deployBlock: number,
    logTag: string,
    scanClient?: ScanClient,
  ): Promise<void> {
    const rpcClient = scanClient ?? client;
    const poolKey = poolAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(poolKey) ?? 0;
    const fromBlock = Math.max(deployBlock, lastScanned + 1);

    const currentBlock = Number(await getBlockNumber(rpcClient));
    console.log(
      `${logTag}🔍 Scanning Aave Pool ${poolAddress.slice(0, 10)}... from block ${fromBlock} to ${currentBlock}`,
    );

    let scanned = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      await this.scanRange(rpcClient, poolAddress, start, end, logTag);
      scanned += end - start + 1;
    }

    this.lastScannedBlock.set(poolKey, currentBlock);
    this.saveToFile();

    const count = this.accounts.get(poolKey)?.size ?? 0;
    console.log(
      `${logTag}✅ Aave scan complete: ${scanned} blocks scanned, ${count} unique accounts found`,
    );
  }

  /**
   * Incremental scan: scan only new blocks since last scan.
   */
  async scanNewEvents(client: ScanClient, poolAddress: Address, logTag: string): Promise<number> {
    const poolKey = poolAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(poolKey);
    if (lastScanned === undefined) {
      console.warn(
        `${logTag}No previous Aave scan found for ${poolAddress.slice(0, 10)}..., skipping`,
      );
      return 0;
    }

    const currentBlock = Number(await getBlockNumber(client));
    const fromBlock = lastScanned + 1;
    if (fromBlock > currentBlock) return 0;

    let newAccounts = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      const added = await this.scanRange(client, poolAddress, start, end, logTag);
      newAccounts += added;
    }

    this.lastScannedBlock.set(poolKey, currentBlock);
    this.saveToFile();

    if (newAccounts > 0) {
      console.log(
        `${logTag}📥 Aave incremental scan: ${newAccounts} new account(s) for ${poolAddress.slice(0, 10)}...`,
      );
    }

    return newAccounts;
  }

  /**
   * Scan a specific block range for the Aave Pool. Returns number of new accounts found.
   */
  private async scanRange(
    client: ScanClient,
    poolAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number> {
    let newAccounts = 0;

    try {
      // Scan all events from the Pool — we decode to extract account addresses
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

          // Extract account addresses from different event types
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

  // ─── Account management ───

  private addAccount(poolAddress: Address, account: Address): number {
    const poolKey = poolAddress.toLowerCase();
    let set = this.accounts.get(poolKey);
    if (!set) {
      set = new Set();
      this.accounts.set(poolKey, set);
    }
    const key = account.toLowerCase();
    if (set.has(key as Address)) return 0;
    set.add(key as Address);
    return 1;
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

  /**
   * Get all known accounts for the Aave V3 Pool.
   */
  getAccounts(poolAddress: Address): Address[] {
    const poolKey = poolAddress.toLowerCase();
    const set = this.accounts.get(poolKey);
    if (!set) return [];
    return [...set] as Address[];
  }

  /**
   * Get total account count across all tracked pools.
   */
  get totalAccounts(): number {
    return [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
  }

  /**
   * Get the last scanned block for a pool.
   */
  getLastScannedBlock(poolAddress: Address): number | undefined {
    return this.lastScannedBlock.get(poolAddress.toLowerCase());
  }
}
