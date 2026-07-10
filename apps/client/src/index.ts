import {
  MARKETS_FETCHING_COOLDOWN_PERIOD,
  POSITION_LIQUIDATION_COOLDOWN_ENABLED,
  POSITION_LIQUIDATION_COOLDOWN_PERIOD,
  ALWAYS_REALIZE_BAD_DEBT,
  type ChainConfig,
} from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import { createLiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { createPricer } from "@morpho-blue-liquidation-bot/pricers";
import { createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { watchBlocks } from "viem/actions";

import { AaveLiquidationBot } from "./aaveBot";
import { LiquidationBot, type LiquidationBotInputs } from "./bot";
import { CometLiquidationBot } from "./cometBot";
import { getHealthServer } from "./health";
import { MoonwellLiquidationBot } from "./moonwellBot";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms";
import type { WebhookServer } from "./webhook";

export const launchBot = async (
  config: ChainConfig,
  dataProvider: DataProvider,
  webhookServer?: WebhookServer,
) => {
  const logTag = `[${config.chain.name} client]: `;
  console.log(`${logTag}Starting up`);

  const client = createWalletClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });

  // LIQUIDITY VENUES
  const liquidityVenues = config.liquidityVenues.map((liquidityVenueName) =>
    createLiquidityVenue(liquidityVenueName),
  );

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

    flashbotAccount = privateKeyToAccount(process.env.FLASHBOTS_PRIVATE_KEY as Hex);
  }

  let positionLiquidationCooldownMechanism = undefined;
  if (POSITION_LIQUIDATION_COOLDOWN_ENABLED) {
    positionLiquidationCooldownMechanism = new PositionLiquidationCooldownMechanism(
      POSITION_LIQUIDATION_COOLDOWN_PERIOD,
    );
  }

  const marketsFetchingCooldownMechanism = new MarketsFetchingCooldownMechanism(
    MARKETS_FETCHING_COOLDOWN_PERIOD,
  );

  // SECURITY (M7): 如果未配置 treasury，盈利直接發送到 EOA，存在安全風險
  const treasuryAddress = config.treasuryAddress ?? client.account.address;
  if (!config.treasuryAddress) {
    console.warn(
      `${logTag}⚠️ 未配置 treasuryAddress，盈利將發送到清算 EOA (${client.account.address})。` +
        `建議配置獨立的多簽 treasury 地址以降低私鑰暴露風險。`,
    );
  }
  const inputs: LiquidationBotInputs = {
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
    flashLoanFallbackProviders: config.flashLoanFallbackProviders,
  };

  const bot = new LiquidationBot(inputs);

  // Initialize cache with full market state + positions before starting
  try {
    await bot.initializeCache();
    bot.startPeriodicRefresh();
  } catch (e) {
    console.error(`${logTag}Cache initialization failed, continuing with lazy-load:`, e);
  }

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
          bot.run().catch((e: unknown) => {
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

  // Register Morpho bot with health server
  const healthServerMorpho = getHealthServer();
  healthServerMorpho.registerBot("morpho", () => bot.getHealthStatus());

  // ─── Compound V3 Comet + Moonwell + Aave Bots (parallel initialization) ───

  const initTasks: Promise<void>[] = [];

  if (config.cometWatchlist?.enabled) {
    initTasks.push(
      (async () => {
        try {
          const cometBot = new CometLiquidationBot({
            logTag: `[${config.chain.name} comet]: `,
            client,
            cometWatchlist: config.cometWatchlist!,
            executorAddress: config.executorAddress,
            treasuryAddress,
            liquidityVenues,
            pricers,
            wNative: config.wNative,
            chainId: config.chainId,
            positionLiquidationCooldownMechanism,
            flashbotAccount,
            useFlashLoan: config.useFlashLoan,
            flashLoanProvider: config.flashLoanProvider,
            flashLoanFallbackProviders: config.flashLoanFallbackProviders,
            alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
            scanRpcUrls: config.scanRpcUrls,
          });

          await cometBot.initialize();
          cometBot.startPolling();
          console.log(`${logTag}✅ Comet liquidation bot started`);

          const healthServer = getHealthServer();
          healthServer.registerBot("comet", () => cometBot.getHealthStatus());
        } catch (e) {
          console.error(`${logTag}Failed to start Comet bot:`, e);
        }
      })(),
    );
  }

  if (config.moonwellWatchlist?.enabled) {
    initTasks.push(
      (async () => {
        try {
          const moonwellBot = new MoonwellLiquidationBot({
            logTag: `[${config.chain.name} moonwell]: `,
            client,
            moonwellWatchlist: config.moonwellWatchlist!,
            executorAddress: config.executorAddress,
            treasuryAddress,
            liquidityVenues,
            pricers,
            wNative: config.wNative,
            chainId: config.chainId,
            positionLiquidationCooldownMechanism,
            flashbotAccount,
            useFlashLoan: config.useFlashLoan,
            flashLoanProvider: config.flashLoanProvider,
            flashLoanFallbackProviders: config.flashLoanFallbackProviders,
            alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
            scanRpcUrls: config.scanRpcUrls,
          });

          await moonwellBot.initialize();
          moonwellBot.startPolling();
          console.log(`${logTag}✅ Moonwell liquidation bot started`);

          const healthServer = getHealthServer();
          healthServer.registerBot("moonwell", () => moonwellBot.getHealthStatus());
        } catch (e) {
          console.error(`${logTag}Failed to start Moonwell bot:`, e);
        }
      })(),
    );
  }

  if (config.aaveWatchlist?.enabled) {
    initTasks.push(
      (async () => {
        try {
          const aaveBot = new AaveLiquidationBot({
            logTag: `[${config.chain.name} aave]: `,
            client,
            aaveWatchlist: config.aaveWatchlist!,
            executorAddress: config.executorAddress,
            treasuryAddress,
            liquidityVenues,
            pricers,
            wNative: config.wNative,
            chainId: config.chainId,
            positionLiquidationCooldownMechanism,
            flashbotAccount,
            useFlashLoan: config.useFlashLoan,
            flashLoanProvider: config.flashLoanProvider,
            flashLoanFallbackProviders: config.flashLoanFallbackProviders,
            alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
            scanRpcUrls: config.scanRpcUrls,
          });

          await aaveBot.initialize();
          aaveBot.startPolling();
          console.log(`${logTag}✅ Aave V3 liquidation bot started`);

          const healthServer = getHealthServer();
          healthServer.registerBot("aave", () => aaveBot.getHealthStatus());
        } catch (e) {
          console.error(`${logTag}Failed to start Aave bot:`, e);
        }
      })(),
    );
  }

  // Initialize all bots in parallel
  await Promise.allSettled(initTasks);

  return bot;
};
