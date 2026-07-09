/**
 * CometAccountRegistry — discovers and tracks accounts that have interacted with Compound V3 Comets.
 *
 * Scans SupplyCollateral / WithdrawCollateral / AbsorbDebt events to build a deduplicated
 * account list per Comet. Supports incremental scanning (only new blocks since last scan).
 * Persists state to a local JSON file to avoid re-scanning from genesis on restart.
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

import { cometEventAbi } from "./abis/Comet.js";

/** Max blocks per eth_getLogs call — Base 公開 RPC 上限 10,000 */
const SCAN_BATCH_SIZE = 10_000;

/** Generic client type for read-only scanning (works with public or wallet clients) */
type ScanClient = Client<Transport, Chain> | WalletClient<Transport, Chain, Account>;

interface RegistryState {
  /** cometAddress (lowercase) → array of unique account addresses */
  accounts: Record<string, string[]>;
  /** cometAddress (lowercase) → last scanned block number */
  lastScannedBlock: Record<string, number>;
}

export class CometAccountRegistry {
  /** cometAddress (lowercase) → Set<account (checksummed)> */
  private accounts = new Map<string, Set<Address>>();
  /** cometAddress (lowercase) → last scanned block */
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
      for (const [comet, addrs] of Object.entries(raw.accounts ?? {})) {
        this.accounts.set(comet, new Set(addrs as Address[]));
      }
      for (const [comet, block] of Object.entries(raw.lastScannedBlock ?? {})) {
        this.lastScannedBlock.set(comet, block);
      }
      const total = [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
      console.log(`[CometRegistry] Loaded ${total} accounts from ${this.filePath}`);
    } catch (e) {
      console.error(`[CometRegistry] Failed to load from ${this.filePath}:`, e);
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
    for (const [comet, set] of this.accounts) {
      state.accounts[comet] = [...set];
    }
    for (const [comet, block] of this.lastScannedBlock) {
      state.lastScannedBlock[comet] = block;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  // ─── Scanning ───

  /**
   * Initial scan: scan from deployBlock to current block for a specific Comet.
   * Processes in batches of SCAN_BATCH_SIZE to avoid RPC limits.
   * @param scanClient - optional read-only client (e.g. Base public RPC) for historical scanning
   */
  async initialScan(
    client: ScanClient,
    cometAddress: Address,
    deployBlock: number,
    logTag: string,
    scanClient?: ScanClient,
  ): Promise<void> {
    const rpcClient = scanClient ?? client;
    const cometKey = cometAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(cometKey) ?? 0;
    const fromBlock = Math.max(deployBlock, lastScanned + 1);

    const currentBlock = Number(await getBlockNumber(rpcClient));
    console.log(
      `${logTag}🔍 Scanning ${cometAddress.slice(0, 10)}... from block ${fromBlock} to ${currentBlock}`,
    );

    let scanned = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      await this.scanRange(rpcClient, cometAddress, start, end, logTag);
      scanned += end - start + 1;
    }

    this.lastScannedBlock.set(cometKey, currentBlock);
    this.saveToFile();

    const count = this.accounts.get(cometKey)?.size ?? 0;
    console.log(
      `${logTag}✅ Scan complete: ${scanned} blocks scanned, ${count} unique accounts found`,
    );
  }

  /**
   * Incremental scan: scan only new blocks since last scan.
   */
  async scanNewEvents(client: ScanClient, cometAddress: Address, logTag: string): Promise<number> {
    const cometKey = cometAddress.toLowerCase();
    const lastScanned = this.lastScannedBlock.get(cometKey);
    if (lastScanned === undefined) {
      console.warn(`${logTag}No previous scan found for ${cometAddress.slice(0, 10)}..., skipping`);
      return 0;
    }

    const currentBlock = Number(await getBlockNumber(client));
    const fromBlock = lastScanned + 1;
    if (fromBlock > currentBlock) return 0;

    let newAccounts = 0;
    for (let start = fromBlock; start <= currentBlock; start += SCAN_BATCH_SIZE) {
      const end = Math.min(start + SCAN_BATCH_SIZE - 1, currentBlock);
      const added = await this.scanRange(client, cometAddress, start, end, logTag);
      newAccounts += added;
    }

    this.lastScannedBlock.set(cometKey, currentBlock);
    this.saveToFile();

    if (newAccounts > 0) {
      console.log(
        `${logTag}📥 Incremental scan: ${newAccounts} new account(s) for ${cometAddress.slice(0, 10)}...`,
      );
    }

    return newAccounts;
  }

  /**
   * Scan a specific block range for a Comet. Returns number of new accounts found.
   */
  private async scanRange(
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
          // For SupplyCollateral: dst is the account that received the collateral
          const dst = args.dst as Address | undefined;
          // For SupplyCollateral: src is who supplied
          const src = args.src as Address | undefined;

          if (dst) newAccounts += this.addAccount(cometAddress, dst);
          if (src) newAccounts += this.addAccount(cometAddress, src);
        } catch {
          // Skip undecodable logs
        }
      }
    } catch {
      // If event-specific filter fails, try a broader filter
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

  // ─── Account management ───

  private addAccount(cometAddress: Address, account: Address): number {
    const cometKey = cometAddress.toLowerCase();
    let set = this.accounts.get(cometKey);
    if (!set) {
      set = new Set();
      this.accounts.set(cometKey, set);
    }
    const key = account.toLowerCase();
    if (set.has(key as Address)) return 0;
    set.add(key as Address);
    return 1;
  }

  /**
   * Get all known accounts for a specific Comet.
   */
  getAccounts(cometAddress: Address): Address[] {
    const cometKey = cometAddress.toLowerCase();
    const set = this.accounts.get(cometKey);
    if (!set) return [];
    return [...set] as Address[];
  }

  /**
   * Get total account count across all Comets.
   */
  get totalAccounts(): number {
    return [...this.accounts.values()].reduce((s, set) => s + set.size, 0);
  }

  /**
   * Get the last scanned block for a Comet.
   */
  getLastScannedBlock(cometAddress: Address): number | undefined {
    return this.lastScannedBlock.get(cometAddress.toLowerCase());
  }
}
