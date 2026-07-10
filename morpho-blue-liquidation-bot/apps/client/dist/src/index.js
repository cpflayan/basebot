import { MARKETS_FETCHING_COOLDOWN_PERIOD, POSITION_LIQUIDATION_COOLDOWN_ENABLED, POSITION_LIQUIDATION_COOLDOWN_PERIOD, ALWAYS_REALIZE_BAD_DEBT, } from "@morpho-blue-liquidation-bot/config";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { createPricer } from "@morpho-blue-liquidation-bot/pricers";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { watchBlocks } from "viem/actions";
import { LiquidationBot } from "./bot";
import { MarketsFetchingCooldownMechanism, PositionLiquidationCooldownMechanism, } from "./utils/cooldownMechanisms";
export const launchBot = (config, dataProvider, webhookServer) => {
    const logTag = `[${config.chain.name} client]: `;
    console.log(`${logTag}Starting up`);
    const client = createWalletClient({
        chain: config.chain,
        transport: http(config.rpcUrl),
        account: privateKeyToAccount(config.liquidationPrivateKey),
    });
    // LIQUIDITY VENUES
    const liquidityVenues = config.liquidityVenues.map((liquidityVenueName) => createLiquidityVenue(liquidityVenueName));
    // PRICERS
    const pricers = config.pricers
        ? config.pricers.map((pricerName) => createPricer(pricerName))
        : undefined;
    // FlASHBOTS
    let flashbotAccount = undefined;
    if (config.useFlashbots) {
        const flashbotsPrivateKey = process.env.FLASHBOTS_PRIVATE_KEY;
        if (flashbotsPrivateKey === undefined) {
            throw new Error(`${logTag} FLASHBOTS_PRIVATE_KEY is not set`);
        }
        flashbotAccount = privateKeyToAccount(process.env.FLASHBOTS_PRIVATE_KEY);
    }
    let positionLiquidationCooldownMechanism = undefined;
    if (POSITION_LIQUIDATION_COOLDOWN_ENABLED) {
        positionLiquidationCooldownMechanism = new PositionLiquidationCooldownMechanism(POSITION_LIQUIDATION_COOLDOWN_PERIOD);
    }
    const marketsFetchingCooldownMechanism = new MarketsFetchingCooldownMechanism(MARKETS_FETCHING_COOLDOWN_PERIOD);
    // SECURITY (M7): 如果未配置 treasury，盈利直接發送到 EOA，存在安全風險
    const treasuryAddress = config.treasuryAddress ?? client.account.address;
    if (!config.treasuryAddress) {
        console.warn(`${logTag}⚠️ 未配置 treasuryAddress，盈利將發送到清算 EOA (${client.account.address})。` +
            `建議配置獨立的多簽 treasury 地址以降低私鑰暴露風險。`);
    }
    const inputs = {
        logTag,
        chainId: config.chainId,
        client,
        wNative: config.wNative,
        vaultWhitelist: config.vaultWhitelist,
        additionalMarketsWhitelist: config.additionalMarketsWhitelist,
        executorAddress: config.executorAddress,
        treasuryAddress,
        dataProvider,
        liquidityVenues,
        pricers,
        marketsFetchingCooldownMechanism,
        positionLiquidationCooldownMechanism,
        flashbotAccount,
        alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
        useFlashLoan: config.useFlashLoan,
        flashLoanProvider: config.flashLoanProvider,
    };
    const bot = new LiquidationBot(inputs);
    // Register bot with webhook server for event-driven triggering
    if (webhookServer) {
        webhookServer.registerBot(bot, logTag);
    }
    const blockInterval = config.blockInterval ?? 1;
    const startWatching = () => {
        // SECURITY (NM4): 重啟時重置 count，避免重啟後立即觸發 bot.run()
        let count = 0;
        watchBlocks(client, {
            onBlock: () => {
                if (count % blockInterval === 0) {
                    bot.run().catch((e) => {
                        console.error(`${logTag} uncaught error in bot.run():`, e);
                    });
                }
                count++;
            },
            onError: (error) => {
                const retryDelay = config.watchBlocksRetryDelayMs ?? 5_000;
                console.error(`${logTag} watchBlocks error, restarting watcher in ${retryDelay}ms:`, error);
                setTimeout(startWatching, retryDelay);
            },
        });
    };
    startWatching();
    return bot;
};
