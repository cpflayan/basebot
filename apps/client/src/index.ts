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
import { createPublicClient, createWalletClient, fallback, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AaveLiquidationBot } from "./aaveBot";
import { LiquidationBot, type LiquidationBotInputs } from "./bot";
import { CometLiquidationBot } from "./cometBot";
import { getHealthServer } from "./health";
import { MoonwellLiquidationBot } from "./moonwellBot";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms";
import { ReadClientPool } from "./utils/rpcFallback.js";
import { SharedBlockBus } from "./utils/sharedExecution.js";
import type { WebhookServer } from "./webhook";

export const launchBot = async (
  config: ChainConfig,
  dataProvider: DataProvider,
  webhookServer?: WebhookServer,
) => {
  const logTag = `[${config.chain.name} client]: `;
  console.log(`${logTag}Starting up`);

  // Write client: Alchemy primary, failover to paid RPCs
  const fallbackRpcUrl = process.env.FALLBACK_RPC_URL;
  const paidRpcUrls = [
    process.env.PAID_RPC_COINBASE,
    process.env.PAID_RPC_CHAINSTACK,
    process.env.PAID_RPC_ZAN,
    process.env.PAID_RPC_GETBLOCK,
  ].filter(Boolean);
  const rpcRetryOpts = { retryCount: 3, retryDelay: 1000 };
  const writeTransports = [
    http(config.rpcUrl, rpcRetryOpts),
    ...paidRpcUrls.map((url) => http(url, rpcRetryOpts)),
    ...(fallbackRpcUrl ? [http(fallbackRpcUrl, rpcRetryOpts)] : []),
  ];
  const mainTransport = fallback(writeTransports, { rank: false });

  const client = createWalletClient({
    chain: config.chain,
    transport: mainTransport,
    account: privateKeyToAccount(config.liquidationPrivateKey),
  });

  // Paid read pool: round-robin across paid RPCs for multicall reads
  const paidReadPool = new ReadClientPool({
    chain: config.chain,
    entries: [
      { label: "chainstack", url: process.env.PAID_RPC_CHAINSTACK ?? config.rpcUrl },
      { label: "coinbase", url: process.env.PAID_RPC_COINBASE ?? config.rpcUrl },
      { label: "zan", url: process.env.PAID_RPC_ZAN ?? config.rpcUrl },
      { label: "getblock", url: process.env.PAID_RPC_GETBLOCK ?? config.rpcUrl },
      { label: "nodereal", url: process.env.PAID_RPC_NODEREAL ?? config.rpcUrl },
    ].filter((e) => e.url !== config.rpcUrl || process.env.PAID_RPC_CHAINSTACK === undefined),
  });
  console.log(`${logTag}💰 Paid read pool: ${paidReadPool.size} endpoints (round-robin)`);

  // Separate public client for watchBlocks — uses free RPC to avoid rate-limiting Alchemy
  const watchRpcUrl = process.env.WATCH_RPC_URL ?? process.env.PUBLIC_RPC_URL_BASE ?? config.rpcUrl;
  const watchClient = createPublicClient({
    chain: config.chain,
    transport: http(watchRpcUrl, rpcRetryOpts),
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
    console.error(
      `${logTag}Cache initialization failed, continuing with lazy-load: ${e instanceof Error ? e.message : e}`,
    );
  }

  // Register bot with webhook server for event-driven triggering
  if (webhookServer) {
    webhookServer.registerBot(bot, logTag);
  }

  const blockInterval = config.blockInterval ?? 1;

  // Shared block bus — single watchBlocks subscription for all bots
  const blockBus = new SharedBlockBus();
  blockBus.register(blockInterval, () => bot.run(), logTag);
  blockBus.start(watchClient, config.watchBlocksRetryDelayMs ?? 5_000);

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
            paidReadPool,
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
          cometBot.startPolling(blockBus);
          console.log(`${logTag}✅ Comet liquidation bot started`);

          const healthServer = getHealthServer();
          healthServer.registerBot("comet", () => cometBot.getHealthStatus());
        } catch (e) {
          console.error(
            `${logTag}Failed to start Comet bot: ${e instanceof Error ? e.message : e}`,
          );
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
            paidReadPool,
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
          moonwellBot.startPolling(blockBus);
          console.log(`${logTag}✅ Moonwell liquidation bot started`);

          const healthServer = getHealthServer();
          healthServer.registerBot("moonwell", () => moonwellBot.getHealthStatus());
        } catch (e) {
          console.error(
            `${logTag}Failed to start Moonwell bot: ${e instanceof Error ? e.message : e}`,
          );
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
            paidReadPool,
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
          aaveBot.startPolling(blockBus);
          console.log(`${logTag}✅ Aave V3 liquidation bot started`);

          const healthServer = getHealthServer();
          healthServer.registerBot("aave", () => aaveBot.getHealthStatus());
        } catch (e) {
          console.error(`${logTag}Failed to start Aave bot: ${e instanceof Error ? e.message : e}`);
        }
      })(),
    );
  }

  // Initialize all bots in parallel
  await Promise.allSettled(initTasks);

  return bot;
};
