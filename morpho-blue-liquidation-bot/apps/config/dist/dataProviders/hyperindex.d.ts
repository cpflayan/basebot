/**
 * HyperIndex indexer configuration.
 *
 * Deployment block numbers and additional factory addresses for each chain.
 * Used by the hyperindex config generator to produce config.yaml.
 */
export interface HyperIndexChainConfig {
    morphoStartBlock: number;
    metaMorphoFactoryStartBlock: number;
    adaptiveCurveIrmStartBlock: number;
    preLiquidationFactoryStartBlock: number;
    /** Additional MetaMorpho factory addresses beyond the primary one from blue-sdk. */
    additionalMetaMorphoFactories?: string[];
}
/**
 * Chain IDs that the HyperIndex indexer supports.
 * A chain must be listed here AND in `chainConfigs` to be indexed.
 */
export declare const hyperIndexChainConfigs: Record<number, HyperIndexChainConfig>;
export declare const hyperIndexChainIds: number[];
