/**
 * BaseAccountRegistry — shared base class for protocol-specific account registries.
 *
 * Provides:
 *   - In-memory account tracking (Map<address, Set<account>>)
 *   - Last-scanned-block tracking per address
 *   - JSON persistence with atomic write (write .tmp → rename)
 *   - Scan orchestration (initialScan, scanNewEvents)
 *
 * Subclasses implement `scanRange()` with protocol-specific event decoding.
 */
import fs from "node:fs";
import path from "node:path";

import {
  type Address,
  type Transport,
  type Chain,
  type Account,
  type Client,
  type WalletClient,
} from "viem";
import { getBlockNumber } from "viem/actions";

/** Max blocks per eth_getLogs call — Base 公開 RPC 上限 10,000 */
const SCAN_BATCH_SIZE = 10_000;

/**
 * 判斷錯誤是否為 RPC rate limit（例如免費公開節點回傳 -32016 "over rate limit"）。
 * BUGFIX: 以前不管什麼錯誤都直接 fallback 成「無 topic 篩選的 broad filter」，
 * 對 rate limit 來說完全是反效果——broad filter 撈的資料量更大，只會被限速得更兇
 * （在實際 log 中可以看到 "Broad log scan failed ... over rate limit"）。
 * 現在 rate limit 錯誤改成延遲後重試原本的窄篩選，而不是立刻擴大掃描範圍。
 */
export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /rate limit|429|too many requests|-32016/i.test(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generic client type for read-only scanning */
export type ScanClient = Client<Transport, Chain> | WalletClient<Transport, Chain, Account>;

interface RegistryState {
  accounts: Record<string, string[]>;
  lastScannedBlock: Record<string, number>;
}

export abstract class BaseAccountRegistry {
  /** address (lowercase) → Set<account (lowercase)> */
  protected accounts = new Map<string, Set<Address>>();
  /** address (lowercase) → last scanned block */
  protected lastScannedBlock = new Map<string, number>();
  /** address (lowercase) → last block written to disk */
  private lastPersistedBlock = new Map<string, number>();
  /** Path for JSON persistence */
  protected filePath: string;
  /** Log prefix (e.g. "[CometRegistry]", "[MoonwellRegistry]") */
  protected abstract readonly logPrefix: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // ─── Persistence ───

  loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as RegistryState;
      for (const [key, addrs] of Object.entries(raw.accounts ?? {})) {
        this.accounts.set(key, new Set(addrs as Address[]));
      }
      for (const [key, block] of Object.entries(raw.lastScannedBlock ?? {})) {
        this.lastScannedBlock.set(key, block);
        this.lastPersistedBlock.set(key, block);
      }
      const total = [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
      console.log(`${this.logPrefix} Loaded ${total} accounts from ${this.filePath}`);
    } catch (e) {
      console.error(`${this.logPrefix} Failed to load from ${this.filePath}:`, e);
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
    for (const [key, set] of this.accounts) {
      state.accounts[key] = [...set];
    }
    for (const [key, block] of this.lastScannedBlock) {
      state.lastScannedBlock[key] = block;
    }
    const tmpPath = this.filePath + ".tmp";
    // Compact JSON — same data, less CPU/disk than pretty-print on every save
    fs.writeFileSync(tmpPath, JSON.stringify(state));
    fs.renameSync(tmpPath, this.filePath);

    // Keep debounce cursors in sync after any explicit save
    for (const [key, block] of this.lastScannedBlock) {
      this.lastPersistedBlock.set(key, block);
    }
  }

  // ─── Scan orchestration ───

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

    const currentBlock = Number(await getBlockNumber(rpcClient));
    console.log(
      `${logTag}🔍 Scanning ${contractAddress.slice(0, 10)}... from block ${fromBlock} to ${currentBlock}`,
    );

    let scanned = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      await this.scanRange(rpcClient, contractAddress, start, end, logTag);
      scanned += end - start + 1;
    }

    this.lastScannedBlock.set(key, currentBlock);
    this.saveToFile(); // always persist after full historical scan

    const count = this.accounts.get(key)?.size ?? 0;
    console.log(
      `${logTag}✅ Scan complete: ${scanned} blocks scanned, ${count} unique accounts found`,
    );
  }

  /**
   * @param persist - When false, updates in-memory state only (caller must save once).
   *   Use for parallel multi-market scans to avoid concurrent write races.
   */
  async scanNewEvents(
    client: ScanClient,
    contractAddress: Address,
    logTag: string,
    persist = true,
  ): Promise<number> {
    const key = contractAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(key);
    if (lastScanned === undefined) {
      console.warn(
        `${logTag}No previous scan found for ${contractAddress.slice(0, 10)}..., skipping`,
      );
      return 0;
    }

    const currentBlock = Number(await getBlockNumber(client));
    const fromBlock = lastScanned + 1;
    if (fromBlock > currentBlock) return 0;

    let newAccounts = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      const added = await this.scanRange(client, contractAddress, start, end, logTag);
      newAccounts += added;
    }

    this.lastScannedBlock.set(key, currentBlock);

    // Only hit disk when accounts changed, or periodically so lastScanned advances
    // are durable without rewriting JSON on every empty poll tick.
    if (persist && (newAccounts > 0 || this.shouldPersistLastScanned(key, currentBlock))) {
      this.saveToFile();
    }

    if (newAccounts > 0) {
      console.log(
        `${logTag}📥 Incremental scan: ${newAccounts} new account(s) for ${contractAddress.slice(0, 10)}...`,
      );
    }

    return newAccounts;
  }

  /**
   * Debounce lastScanned-only disk writes: persist at most once per ~200 blocks
   * of progress without new accounts. In-memory lastScanned is always current;
   * a crash only causes a short re-scan.
   */
  private shouldPersistLastScanned(key: string, currentBlock: number): boolean {
    const lastPersisted = this.lastPersistedBlock.get(key) ?? 0;
    return currentBlock - lastPersisted >= 200;
  }

  // ─── Abstract: protocol-specific event scanning ───

  protected abstract scanRange(
    client: ScanClient,
    contractAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number>;

  // ─── Account management ───

  protected addAccount(contractAddress: Address, account: Address): number {
    const key = contractAddress.toLowerCase();
    let set = this.accounts.get(key);
    if (!set) {
      set = new Set();
      this.accounts.set(key, set);
    }
    const accountKey = account.toLowerCase();
    if (set.has(accountKey as Address)) return 0;
    set.add(accountKey as Address);
    return 1;
  }

  getAccounts(contractAddress: Address): Address[] {
    const key = contractAddress.toLowerCase();
    const set = this.accounts.get(key);
    if (!set) return [];
    return [...set] as Address[];
  }

  get totalAccounts(): number {
    return [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
  }

  getLastScannedBlock(contractAddress: Address): number | undefined {
    return this.lastScannedBlock.get(contractAddress.toLowerCase());
  }
}
