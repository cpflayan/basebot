import { Address } from "viem";
export type MidasConfig = {
    instantRedemptionVault: Address;
    redemptionAssets: Address[];
};
export declare const midasConfigs: Record<number, Record<Address, MidasConfig>>;
