/**
 * BaseAccountRegistry — shared base class for protocol-specific account registries.
 *
 * Provides:
 *   - In-memory account tracking (Map<address, Set<account>>)
 *   - Last-scanned-block tracking per address
 *   - Split persistence: large accounts file + tiny checkpoint (block cursors)
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
 * How often to flush the large accounts JSON during historical backfill.
 * Durable resume position advances only when accounts are written.
 */
const ACCOUNTS_SAVE_INTERVAL_BLOCKS = 50_000;

/**
 * How often to flush the tiny checkpoint file during backfill when there are
 * no unsaved account changes (safe cursor-only writes).
 */
const CHECKPOINT_SAVE_INTERVAL_BLOCKS = 5_000;

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

/** Large accounts file — optionally carries legacy lastScannedBlock for migration. */
interface AccountsFileState {
  accounts: Record<string, string[]>;
  /** @deprecated Prefer checkpoint file; kept for backward-compatible loads. */
  lastScannedBlock?: Record<string, number>;
}

/**
 * Tiny checkpoint file — rewritten frequently without touching the accounts blob.
 *
 * - lastScannedBlock: highest block scanned in memory (may be ahead of accounts)
 * - accountsSyncedBlock: highest block whose discoveries are durable on disk
 *
 * Resume always uses accountsSyncedBlock so a crash never skips undiscovered accounts.
 */
interface CheckpointFileState {
  lastScannedBlock: Record<string, number>;
  accountsSyncedBlock: Record<string, number>;
}

export abstract class BaseAccountRegistry {
  /** address (lowercase) → Set<account (lowercase)> */
  protected accounts = new Map<string, Set<Address>>();
  /** address (lowercase) → last scanned block (in-memory progress) */
  protected lastScannedBlock = new Map<string, number>();
  /**
   * address (lowercase) → last block whose account discoveries are on disk.
   * Resume / getLastScannedBlock durability is based on this.
   */
  private accountsSyncedBlock = new Map<string, number>();
  /** address (lowercase) → last block written to checkpoint on disk */
  private lastPersistedBlock = new Map<string, number>();
  /** True when in-memory accounts have not been flushed since last mutation. */
  private accountsDirty = false;
  /** Path for accounts JSON persistence */
  protected filePath: string;
  /** Log prefix (e.g. "[CometRegistry]", "[MoonwellRegistry]") */
  protected abstract readonly logPrefix: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Tiny sibling of the accounts file, e.g. aave-accounts.8453.checkpoint.json */
  protected get checkpointPath(): string {
    if (this.filePath.endsWith(".json")) {
      return `${this.filePath.slice(0, -".json".length)}.checkpoint.json`;
    }
    return `${this.filePath}.checkpoint.json`;
  }

  /** Blocks per eth_getLogs call — subclasses may lower for heavy contracts. */
  protected get scanBatchSize(): number {
    return SCAN_BATCH_SIZE;
  }

  /** Optional delay between batches (Aave rate-limit softener). Overridable getter. */
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- subclasses override this getter
  protected get scanDelayMs(): number {
    return 0;
  }

  /** How often to rewrite the large accounts file during initialScan. */
  protected get accountsSaveIntervalBlocks(): number {
    return ACCOUNTS_SAVE_INTERVAL_BLOCKS;
  }

  /** How often to rewrite the tiny checkpoint when accounts are clean. */
  protected get checkpointSaveIntervalBlocks(): number {
    return CHECKPOINT_SAVE_INTERVAL_BLOCKS;
  }

  // ─── Persistence ───

  loadFromFile(): void {
    this.loadAccountsFile();
    this.loadCheckpointFile();

    // Durable resume cursor = accounts synced on disk (never skip unsaved discoveries).
    for (const [key, block] of this.accountsSyncedBlock) {
      this.lastScannedBlock.set(key, block);
      this.lastPersistedBlock.set(key, block);
    }
    // If only legacy lastScanned existed (no accountsSynced), keep lastScanned as-is.
    for (const [key, block] of this.lastScannedBlock) {
      if (!this.accountsSyncedBlock.has(key)) {
        this.accountsSyncedBlock.set(key, block);
        this.lastPersistedBlock.set(key, block);
      }
    }

    const absAccounts = path.resolve(this.filePath);
    const absCheckpoint = path.resolve(this.checkpointPath);
    const total = [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
    if (total > 0 || this.lastScannedBlock.size > 0) {
      const cursors = [...this.lastScannedBlock.entries()]
        .map(([k, b]) => `${k.slice(0, 10)}…@${b}`)
        .join(", ");
      console.log(
        `${this.logPrefix} Loaded ${total} accounts from ${absAccounts}` +
          (cursors ? ` (resume ${cursors})` : ""),
      );
      console.log(
        `${this.logPrefix} Checkpoint file: ${absCheckpoint} ` +
          `(exists=${fs.existsSync(this.checkpointPath)})`,
      );
    } else {
      console.log(
        `${this.logPrefix} No prior registry at ${absAccounts} ` +
          `(checkpoint ${absCheckpoint} exists=${fs.existsSync(this.checkpointPath)})`,
      );
    }
  }

  private loadAccountsFile(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as AccountsFileState;
      for (const [key, addrs] of Object.entries(raw.accounts ?? {})) {
        this.accounts.set(key, new Set(addrs as Address[]));
      }
      // Legacy: lastScanned embedded in accounts file (pre-split checkpoint format)
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional migration path
      const legacyCursors = raw.lastScannedBlock ?? {};
      for (const [key, block] of Object.entries(legacyCursors)) {
        if (typeof block === "number" && Number.isFinite(block)) {
          this.lastScannedBlock.set(key, block);
          this.accountsSyncedBlock.set(key, block);
        }
      }
    } catch (e) {
      console.error(`${this.logPrefix} Failed to load accounts from ${this.filePath}:`, e);
    }
  }

  private loadCheckpointFile(): void {
    if (!fs.existsSync(this.checkpointPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.checkpointPath, "utf-8")) as CheckpointFileState;
      for (const [key, block] of Object.entries(raw.accountsSyncedBlock ?? {})) {
        if (typeof block === "number" && Number.isFinite(block)) {
          this.accountsSyncedBlock.set(key, block);
        }
      }
      for (const [key, block] of Object.entries(raw.lastScannedBlock ?? {})) {
        if (typeof block === "number" && Number.isFinite(block)) {
          // Prefer accountsSynced when present; otherwise treat lastScanned as durable
          // (older checkpoints or cursor-only files after clean saves).
          if (!this.accountsSyncedBlock.has(key)) {
            this.accountsSyncedBlock.set(key, block);
          }
          this.lastScannedBlock.set(key, block);
        }
      }
    } catch (e) {
      console.error(`${this.logPrefix} Failed to load checkpoint from ${this.checkpointPath}:`, e);
    }
  }

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private atomicWriteJson(filePath: string, value: unknown): void {
    this.ensureDir(filePath);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(value));
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Write only the large accounts blob. Does not update checkpoint cursors.
   * Call {@link saveCheckpoint} (or {@link saveToFile}) after to mark accounts synced.
   */
  saveAccounts(): void {
    const state: AccountsFileState = { accounts: {} };
    for (const [key, set] of this.accounts) {
      state.accounts[key] = [...set];
    }
    this.atomicWriteJson(this.filePath, state);

    for (const [key, block] of this.lastScannedBlock) {
      this.accountsSyncedBlock.set(key, block);
    }
    this.accountsDirty = false;
  }

  /**
   * Write only the tiny block-cursor file. Safe mid-scan when accounts are clean;
   * when dirty, accountsSyncedBlock lags so a crash will re-scan the gap.
   */
  saveCheckpoint(): void {
    const state: CheckpointFileState = {
      lastScannedBlock: {},
      accountsSyncedBlock: {},
    };
    for (const [key, block] of this.lastScannedBlock) {
      state.lastScannedBlock[key] = block;
    }
    for (const [key, block] of this.accountsSyncedBlock) {
      state.accountsSyncedBlock[key] = block;
    }
    // If accounts are clean, durable cursor can catch up to in-memory scan progress.
    if (!this.accountsDirty) {
      for (const [key, block] of this.lastScannedBlock) {
        state.accountsSyncedBlock[key] = block;
        this.accountsSyncedBlock.set(key, block);
      }
    }
    this.atomicWriteJson(this.checkpointPath, state);

    for (const [key, block] of this.accountsSyncedBlock) {
      this.lastPersistedBlock.set(key, block);
    }
  }

  /**
   * Full flush: accounts + checkpoint. Preferred after historical scan completion
   * or when new accounts were discovered.
   */
  saveToFile(): void {
    this.saveAccounts();
    this.saveCheckpoint();
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
    // Durable resume (accounts synced), not in-memory-only lastScanned.
    const lastDurable = this.accountsSyncedBlock.get(key) ?? this.lastScannedBlock.get(key) ?? 0;
    const fromBlock = Math.max(deployBlock, lastDurable + 1);

    const currentBlock = Number(await getBlockNumber(rpcClient));
    const gap = Math.max(0, currentBlock - fromBlock + 1);
    const mode =
      lastDurable > 0
        ? fromBlock > deployBlock
          ? "INCREMENTAL_RESUME"
          : "FULL_FROM_DEPLOY"
        : "FULL_FROM_DEPLOY";

    // D: make resume vs full-history obvious in logs
    console.log(
      `${logTag}📍 Scan plan: mode=${mode} durableCheckpoint=${lastDurable || "none"} ` +
        `deployBlock=${deployBlock} fromBlock=${fromBlock} tip=${currentBlock} gap≈${gap} blocks`,
    );
    console.log(
      `${logTag}⚙️ Scan config: batchSize=${this.scanBatchSize} delayMs=${this.scanDelayMs} ` +
        `accountsFlushEvery=${this.accountsSaveIntervalBlocks} checkpointEvery=${this.checkpointSaveIntervalBlocks} ` +
        `file=${path.resolve(this.filePath)}`,
    );
    if (mode === "FULL_FROM_DEPLOY" && gap > 1_000_000) {
      console.warn(
        `${logTag}⚠️ FULL history scan of ~${gap} blocks — prefer pnpm backfill:aave offline. ` +
          `If you expected resume, check that checkpoint exists under ACCOUNT_REGISTRY_DIR.`,
      );
    }
    console.log(
      `${logTag}🔍 Scanning ${contractAddress.slice(0, 10)}... from block ${fromBlock} to ${currentBlock}`,
    );

    if (fromBlock > currentBlock) {
      this.lastScannedBlock.set(key, currentBlock);
      if (!this.accountsSyncedBlock.has(key)) {
        this.accountsSyncedBlock.set(key, currentBlock);
      }
      this.saveCheckpoint();
      const count = this.accounts.get(key)?.size ?? 0;
      console.log(
        `${logTag}✅ Scan complete: already at tip (checkpoint ${lastDurable} ≥ tip ${currentBlock}), ${count} accounts`,
      );
      return;
    }

    const batchSize = this.scanBatchSize;
    const delayMs = this.scanDelayMs;
    const accountsInterval = this.accountsSaveIntervalBlocks;
    const checkpointInterval = this.checkpointSaveIntervalBlocks;

    let scanned = 0;
    let lastAccountsFlushAt = lastDurable;
    let lastCheckpointFlushAt = lastDurable;

    try {
      for (let start = fromBlock; start <= currentBlock; start += batchSize) {
        const end = Math.min(start + batchSize - 1, currentBlock);
        // Only advance cursor after a successful scanRange (throws → leave gap for resume)
        const added = await this.scanRange(rpcClient, contractAddress, start, end, logTag);
        if (added > 0) this.accountsDirty = true;

        this.lastScannedBlock.set(key, end);
        scanned += end - start + 1;

        const blocksSinceAccounts = end - lastAccountsFlushAt;
        const blocksSinceCheckpoint = end - lastCheckpointFlushAt;

        // A: durable mid-scan checkpoint — dirty → flush accounts+cursor; clean → cursor only
        if (this.accountsDirty && blocksSinceAccounts >= accountsInterval) {
          this.saveAccounts();
          this.saveCheckpoint();
          lastAccountsFlushAt = end;
          lastCheckpointFlushAt = end;
          console.log(
            `${logTag}💾 Accounts+checkpoint @ block ${end} (${this.accounts.get(key)?.size ?? 0} accounts)`,
          );
        } else if (blocksSinceCheckpoint >= checkpointInterval) {
          this.saveCheckpoint();
          lastCheckpointFlushAt = end;
          if (scanned % (checkpointInterval * 4) < batchSize) {
            console.log(
              `${logTag}📌 Checkpoint cursor @ block ${end}` +
                (this.accountsDirty
                  ? " (accounts dirty — durable resume lags until accounts flush)"
                  : ""),
            );
          }
        }

        if (delayMs > 0) await sleep(delayMs);
      }
    } catch (e) {
      // Persist whatever we successfully scanned so restart resumes past deploy block
      this.saveToFile();
      const durable = this.accountsSyncedBlock.get(key) ?? 0;
      console.error(
        `${logTag}❌ Scan aborted at progress lastScanned=${this.lastScannedBlock.get(key)} ` +
          `durableCheckpoint=${durable}. Restart will resume from ${durable + 1}.`,
        e,
      );
      throw e;
    }

    this.lastScannedBlock.set(key, currentBlock);
    this.saveToFile(); // always full flush after historical scan

    const count = this.accounts.get(key)?.size ?? 0;
    console.log(
      `${logTag}✅ Scan complete: ${scanned} blocks scanned, ${count} unique accounts found ` +
        `(checkpoint @ ${this.lastScannedBlock.get(key)})`,
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

    const batchSize = this.scanBatchSize;
    let newAccounts = 0;
    for (let start = fromBlock; start <= currentBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, currentBlock);
      const added = await this.scanRange(client, contractAddress, start, end, logTag);
      newAccounts += added;
    }

    this.lastScannedBlock.set(key, currentBlock);
    if (newAccounts > 0) this.accountsDirty = true;

    // New accounts → flush both files. Empty progress → tiny checkpoint only.
    if (persist) {
      if (newAccounts > 0) {
        this.saveToFile();
      } else if (this.shouldPersistLastScanned(key, currentBlock)) {
        this.saveCheckpoint();
      }
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
    this.accountsDirty = true;
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

  /**
   * Bulk-import addresses (e.g. from a subgraph backfill). Returns how many were new.
   */
  importAccounts(contractAddress: Address, accounts: Iterable<Address>): number {
    let added = 0;
    for (const account of accounts) {
      added += this.addAccount(contractAddress, account);
    }
    return added;
  }

  /**
   * Mark durable scan progress through `block` (accounts assumed complete up to this block).
   * Used by external backfill (subgraph / offline script) so the bot only does incremental work.
   */
  markSynced(contractAddress: Address, block: number): void {
    const key = contractAddress.toLowerCase();
    const prev = this.lastScannedBlock.get(key) ?? 0;
    const next = Math.max(prev, block);
    this.lastScannedBlock.set(key, next);
    this.accountsSyncedBlock.set(key, next);
    this.lastPersistedBlock.set(key, next);
  }

  /** True when a durable checkpoint exists for this contract (safe for incremental-only mode). */
  hasCheckpoint(contractAddress: Address): boolean {
    return this.getLastScannedBlock(contractAddress) !== undefined;
  }
}
