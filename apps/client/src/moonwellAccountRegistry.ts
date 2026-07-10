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

import { mTokenEventAbi } from "./abis/Moonwell.js";

/** Max blocks per eth_getLogs call — Base 公開 RPC 上限 10,000 */
const SCAN_BATCH_SIZE = 10_000;

/** Generic client type for read-only scanning */
type ScanClient = Client<Transport, Chain> | WalletClient<Transport, Chain, Account>;

interface RegistryState {
  /** mToken address (lowercase) → array of unique account addresses */
  accounts: Record<string, string[]>;
  /** mToken address (lowercase) → last scanned block number */
  lastScannedBlock: Record<string, number>;
}

export class MoonwellAccountRegistry {
  /** mToken address (lowercase) → Set<account (lowercase)> */
  private accounts = new Map<string, Set<Address>>();
  /** mToken address (lowercase) → last scanned block */
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
      for (const [mToken, addrs] of Object.entries(raw.accounts ?? {})) {
        this.accounts.set(mToken, new Set(addrs as Address[]));
      }
      for (const [mToken, block] of Object.entries(raw.lastScannedBlock ?? {})) {
        this.lastScannedBlock.set(mToken, block);
      }
      const total = [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
      console.log(`[MoonwellRegistry] Loaded ${total} accounts from ${this.filePath}`);
    } catch (e) {
      console.error(`[MoonwellRegistry] Failed to load from ${this.filePath}:`, e);
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
    for (const [mToken, set] of this.accounts) {
      state.accounts[mToken] = [...set];
    }
    for (const [mToken, block] of this.lastScannedBlock) {
      state.lastScannedBlock[mToken] = block;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  // ─── Scanning ───

  /**
   * Initial scan: scan from deployBlock to current block for a specific mToken.
   * Processes in batches of SCAN_BATCH_SIZE to avoid RPC limits.
   */
  async initialScan(
    client: ScanClient,
    mTokenAddress: Address,
    deployBlock: number,
    logTag: string,
    scanClient?: ScanClient,
  ): Promise<void> {
    const rpcClient = scanClient ?? client;
    const mTokenKey = mTokenAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(mTokenKey) ?? 0;
    const fromBlock = Math.max(deployBlock, lastScanned + 1);

    const currentBlock = Number(await getBlockNumber(rpcClient));
    console.log(
      `${logTag}🔍 Scanning mToken ${mTokenAddress.slice(0, 10)}... from block ${fromBlock} to ${currentBlock}`,
    );

    let scanned = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      await this.scanRange(rpcClient, mTokenAddress, start, end, logTag);
      scanned += end - start + 1;
    }

    this.lastScannedBlock.set(mTokenKey, currentBlock);
    this.saveToFile();

    const count = this.accounts.get(mTokenKey)?.size ?? 0;
    console.log(
      `${logTag}✅ Scan complete: ${scanned} blocks scanned, ${count} unique accounts found for ${mTokenAddress.slice(0, 10)}...`,
    );
  }

  /**
   * Incremental scan: scan only new blocks since last scan.
   */
  async scanNewEvents(client: ScanClient, mTokenAddress: Address, logTag: string): Promise<number> {
    const mTokenKey = mTokenAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(mTokenKey);
    if (lastScanned === undefined) {
      console.warn(
        `${logTag}No previous scan found for ${mTokenAddress.slice(0, 10)}..., skipping`,
      );
      return 0;
    }

    const currentBlock = Number(await getBlockNumber(client));
    const fromBlock = lastScanned + 1;
    if (fromBlock > currentBlock) return 0;

    let newAccounts = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      const added = await this.scanRange(client, mTokenAddress, start, end, logTag);
      newAccounts += added;
    }

    this.lastScannedBlock.set(mTokenKey, currentBlock);
    this.saveToFile();

    if (newAccounts > 0) {
      console.log(
        `${logTag}📥 Incremental scan: ${newAccounts} new account(s) for ${mTokenAddress.slice(0, 10)}...`,
      );
    }

    return newAccounts;
  }

  /**
   * Scan a specific block range for a mToken. Returns number of new accounts found.
   * Focuses on Borrow events to discover accounts with debt.
   */
  private async scanRange(
    client: ScanClient,
    mTokenAddress: Address,
    fromBlock: number,
    toBlock: number,
    logTag: string,
  ): Promise<number> {
    let newAccounts = 0;

    try {
      // Scan Borrow events — these indicate accounts with debt (liquidatable)
      const logs = await getLogs(client, {
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
    } catch {
      // Fallback: broad log scan
      console.warn(
        `${logTag}Event filter failed for ${mTokenAddress.slice(0, 10)}... blocks ${fromBlock}-${toBlock}, trying broad filter`,
      );
      try {
        const logs = await getLogs(client, {
          address: mTokenAddress,
          fromBlock: BigInt(fromBlock),
          toBlock: BigInt(toBlock),
        });

        for (const log of logs) {
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
    }

    return newAccounts;
  }

  // ─── Account management ───

  private addAccount(mTokenAddress: Address, account: Address): number {
    const mTokenKey = mTokenAddress.toLowerCase();
    let set = this.accounts.get(mTokenKey);
    if (!set) {
      set = new Set();
      this.accounts.set(mTokenKey, set);
    }
    const key = account.toLowerCase();
    if (set.has(key as Address)) return 0;
    set.add(key as Address);
    return 1;
  }

  /**
   * Get all known accounts for a specific mToken.
   */
  getAccounts(mTokenAddress: Address): Address[] {
    const mTokenKey = mTokenAddress.toLowerCase();
    const set = this.accounts.get(mTokenKey);
    if (!set) return [];
    return [...set] as Address[];
  }

  /**
   * Get total account count across all mTokens.
   */
  get totalAccounts(): number {
    return [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
  }

  /**
   * Get the last scanned block for a mToken.
   */
  getLastScannedBlock(mTokenAddress: Address): number | undefined {
    return this.lastScannedBlock.get(mTokenAddress.toLowerCase());
  }
}
