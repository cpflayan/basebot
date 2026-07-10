import type { Address } from "viem";
type Contracts = "PoolManager" | "Quoter" | "StateView" | "UniversalRouter" | "Permit2" | "Native";
export declare const DEPLOYMENTS: Record<number, Record<Contracts, {
    address: Address;
    fromBlock?: bigint;
}>>;
export {};
