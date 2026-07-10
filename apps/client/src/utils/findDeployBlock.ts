/**
 * findDeployBlock — shared utility for locating the exact deployment block of a contract.
 *
 * Uses exponential search + binary search via eth_getCode.
 * Originally extracted from CometLiquidationBot.findDeployBlock().
 *
 * @param client - Read-only viem client (e.g. Base public RPC)
 * @param contractAddress - Contract address to locate
 * @param estimatedBlock - Estimated deployment block (from config or documentation)
 * @param logTag - Log prefix for diagnostic messages
 * @returns Exact deployment block number, or undefined if search fails
 */
import type { Address, Chain, Client, Transport } from "viem";
import { getBlockNumber, getCode } from "viem/actions";

export async function findDeployBlock(
  client: Client<Transport, Chain>,
  contractAddress: Address,
  estimatedBlock: number,
  logTag: string,
): Promise<number | undefined> {
  try {
    const currentBlock = Number(await getBlockNumber(client));

    // Step 1: Check if contract exists at estimated block
    let code = await getCode(client, {
      address: contractAddress,
      blockNumber: BigInt(estimatedBlock),
    });

    let lo: number;
    let hi: number;

    if (code && code !== "0x") {
      // Contract exists at estimated block — search backwards
      hi = estimatedBlock;
      lo = Math.max(0, estimatedBlock - 100_000);
      let step = 100_000;

      // Exponential expansion backwards
      while (lo > 0) {
        code = await getCode(client, {
          address: contractAddress,
          blockNumber: BigInt(lo),
        });
        if (code && code !== "0x") {
          hi = lo;
          lo = Math.max(0, lo - step);
          step *= 2;
        } else {
          break;
        }
      }
    } else {
      // Contract doesn't exist at estimated block — search forwards
      lo = estimatedBlock;
      hi = estimatedBlock;
      let step = 100_000;
      let found = false;

      // Exponential expansion forwards
      while (hi < currentBlock) {
        hi += step;
        step *= 2;
        code = await getCode(client, {
          address: contractAddress,
          blockNumber: BigInt(hi),
        });
        if (code && code !== "0x") {
          found = true;
          break;
        }
      }

      if (!found) {
        console.warn(
          `${logTag}⚠️ Contract ${contractAddress.slice(0, 10)}... not found up to block ${hi}`,
        );
        return undefined;
      }
    }

    // Step 2: Binary search in [lo, hi]
    let searchLo = lo;
    let searchHi = hi;
    while (searchLo < searchHi) {
      const mid = Math.floor((searchLo + searchHi) / 2);
      const codeAtMid = await getCode(client, {
        address: contractAddress,
        blockNumber: BigInt(mid),
      });

      if (codeAtMid && codeAtMid !== "0x") {
        searchHi = mid;
      } else {
        searchLo = mid + 1;
      }
    }

    return searchLo;
  } catch (e) {
    console.warn(
      `${logTag}⚠️ Deploy block search failed for ${contractAddress.slice(0, 10)}..., using configured value:`,
      e,
    );
    return undefined;
  }
}
