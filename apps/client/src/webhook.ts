import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { decodeEventLog, type Hex, toEventSelector } from "viem";

import type { LiquidationBot } from "./bot.js";

/**
 * Morpho Blue events that can create liquidation opportunities.
 * - Borrow: increases debt → lowers HF
 * - WithdrawCollateral: reduces collateral → lowers HF
 * - Withdraw: supply-side withdrawal, may affect market state
 */
export const MORPHO_EVENT_SIGNATURES = [
  "Borrow(bytes32,address,address,address,uint256,uint256)",
  "WithdrawCollateral(bytes32,address,address,address,uint256)",
  "Withdraw(bytes32,address,address,address,uint256,uint256)",
  "SupplyCollateral(bytes32,address,address,uint256)",
  "Repay(bytes32,address,address,address,uint256,uint256)",
  "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256)",
] as const;

/**
 * Minimal MorphoBlue ABI for event decoding.
 */
const morphoEventAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: false, name: "caller", type: "address" },
      { indexed: true, name: "onBehalf", type: "address" },
      { indexed: true, name: "receiver", type: "address" },
      { indexed: false, name: "assets", type: "uint256" },
      { indexed: false, name: "shares", type: "uint256" },
    ],
    name: "Borrow",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: false, name: "caller", type: "address" },
      { indexed: true, name: "onBehalf", type: "address" },
      { indexed: true, name: "receiver", type: "address" },
      { indexed: false, name: "assets", type: "uint256" },
    ],
    name: "WithdrawCollateral",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: false, name: "caller", type: "address" },
      { indexed: true, name: "onBehalf", type: "address" },
      { indexed: true, name: "receiver", type: "address" },
      { indexed: false, name: "assets", type: "uint256" },
      { indexed: false, name: "shares", type: "uint256" },
    ],
    name: "Withdraw",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: true, name: "caller", type: "address" },
      { indexed: true, name: "onBehalf", type: "address" },
      { indexed: false, name: "assets", type: "uint256" },
    ],
    name: "SupplyCollateral",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: false, name: "caller", type: "address" },
      { indexed: true, name: "onBehalf", type: "address" },
      { indexed: true, name: "receiver", type: "address" },
      { indexed: false, name: "assets", type: "uint256" },
      { indexed: false, name: "shares", type: "uint256" },
    ],
    name: "Repay",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: true, name: "liquidator", type: "address" },
      { indexed: false, name: "user", type: "address" },
      { indexed: false, name: "repayAssets", type: "uint256" },
      { indexed: false, name: "repayShares", type: "uint256" },
      { indexed: false, name: "seizedAssets", type: "uint256" },
      { indexed: false, name: "seizedShares", type: "uint256" },
    ],
    name: "Liquidate",
    type: "event",
  },
] as const;

/** Decoded MorphoBlue event passed to the bot */
export interface DecodedMorphoEvent {
  eventName: string;
  marketId: Hex;
  user: Hex;
  assets?: bigint;
  shares?: bigint;
}

/**
 * Decode a raw log entry from the webhook into a structured event.
 */
export function decodeMorphoLog(log: {
  topics: [Hex, ...Hex[]];
  data: Hex;
}): DecodedMorphoEvent | undefined {
  try {
    const decoded = decodeEventLog({
      abi: morphoEventAbi,
      topics: log.topics,
      data: log.data,
    });

    const args = decoded.args as Record<string, unknown>;
    const marketId = args.id as Hex;
    const user = (args.onBehalf ?? args.user) as Hex;

    return {
      eventName: decoded.eventName,
      marketId,
      user,
      assets: args.assets as bigint | undefined,
      shares: args.shares as bigint | undefined,
    };
  } catch {
    return undefined;
  }
}

interface RegisteredBot {
  bot: LiquidationBot;
  logTag: string;
}

export class WebhookServer {
  private fastify: FastifyInstance;
  private port: number;
  private host: string;
  private bots: RegisteredBot[] = [];
  private topic0Set: Set<string>;
  private lastTriggerTime = 0;
  /** Minimum interval between webhook-triggered runs (ms) */
  private cooldownMs: number;

  constructor(port = 3001, host = "0.0.0.0", cooldownMs = 2000) {
    this.port = port;
    this.host = host;
    this.cooldownMs = cooldownMs;

    // Pre-compute topic0 hashes from event signatures
    this.topic0Set = new Set(MORPHO_EVENT_SIGNATURES.map((sig) => toEventSelector(sig)));

    this.fastify = Fastify({ logger: false });
    this.setupRoutes();
  }

  private setupRoutes() {
    // Alchemy sends POST to this endpoint
    this.fastify.post("/webhook", async (request, reply) => {
      try {
        const body = request.body as Record<string, unknown> | undefined;
        const logs = (body?.event as Record<string, unknown> | undefined)?.data as
          | Record<string, unknown>
          | undefined;
        const logArray = logs?.block as Record<string, unknown> | undefined;
        const logsList = logArray?.logs;

        if (!Array.isArray(logsList)) {
          return await reply.code(200).send({ status: "ok", triggered: false, reason: "no logs" });
        }

        // Filter for relevant Morpho events
        const matchingLogs = logsList.filter((log: Record<string, unknown>) => {
          const topics = log.topics as string[] | undefined;
          const topic0 = topics?.[0];
          return topic0 && this.topic0Set.has(topic0.toLowerCase());
        });

        if (matchingLogs.length === 0) {
          return await reply
            .code(200)
            .send({ status: "ok", triggered: false, reason: "no matching events" });
        }

        // Decode all matching events
        const decodedEvents: DecodedMorphoEvent[] = [];
        for (const log of matchingLogs) {
          const topics = log.topics as [Hex, ...Hex[]];
          const data = log.data as Hex;
          const decoded = decodeMorphoLog({ topics, data });
          if (decoded) decodedEvents.push(decoded);
        }

        if (decodedEvents.length === 0) {
          return await reply
            .code(200)
            .send({ status: "ok", triggered: false, reason: "no decodable events" });
        }

        // Cooldown: avoid triggering multiple times within cooldownMs
        const now = Date.now();
        if (now - this.lastTriggerTime < this.cooldownMs) {
          return await reply.code(200).send({
            status: "ok",
            triggered: false,
            reason: "cooldown",
            matchingEvents: decodedEvents.length,
          });
        }
        this.lastTriggerTime = now;

        console.log(
          `[Webhook] ${decodedEvents.length} Morpho event(s) decoded, triggering ${this.bots.length} bot(s)`,
        );

        // Trigger all registered bots with decoded events (fire-and-forget)
        for (const { bot, logTag } of this.bots) {
          bot.handleEvents(decodedEvents).catch((e: unknown) => {
            console.error(`${logTag} event-driven handling failed:`, e);
          });
        }

        return await reply.code(200).send({
          status: "ok",
          triggered: true,
          matchingEvents: decodedEvents.length,
        });
      } catch (error) {
        console.error("[Webhook] Error processing payload:", error);
        return await reply.code(200).send({ status: "ok", triggered: false, reason: "error" });
      }
    });

    // Health check endpoint for webhook server
    this.fastify.get("/health", async (_request, reply) => {
      return reply.code(200).send({
        status: "ok",
        registeredBots: this.bots.length,
      });
    });
  }

  registerBot(bot: LiquidationBot, logTag: string) {
    this.bots.push({ bot, logTag });
    console.log(`[Webhook] Registered bot: ${logTag}`);
  }

  async start() {
    await this.fastify.listen({ port: this.port, host: this.host });
    console.log(`📡 Webhook server listening on http://${this.host}:${this.port}/webhook`);
  }

  async stop() {
    await this.fastify.close();
  }
}
