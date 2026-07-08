import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { toEventSelector } from "viem";

import type { LiquidationBot } from "./bot.js";

/**
 * Morpho Blue events that can create liquidation opportunities.
 * - Borrow: increases debt → lowers HF
 * - WithdrawCollateral: reduces collateral → lowers HF
 * - Withdraw: supply-side withdrawal, may affect market state
 */
const MORPHO_EVENT_SIGNATURES = [
  "Borrow(bytes32,address,address,address,uint256,uint256)",
  "WithdrawCollateral(bytes32,address,address,address,uint256)",
  "Withdraw(bytes32,address,address,address,uint256,uint256)",
] as const;

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

        // Cooldown: avoid triggering multiple times within cooldownMs
        const now = Date.now();
        if (now - this.lastTriggerTime < this.cooldownMs) {
          return await reply.code(200).send({
            status: "ok",
            triggered: false,
            reason: "cooldown",
            matchingEvents: matchingLogs.length,
          });
        }
        this.lastTriggerTime = now;

        // Trigger all registered bots (fire-and-forget)
        console.log(
          `[Webhook] ${matchingLogs.length} Morpho event(s) detected, triggering ${this.bots.length} bot(s)`,
        );

        for (const { bot, logTag } of this.bots) {
          bot.run().catch((e: unknown) => {
            console.error(`${logTag} webhook-triggered run failed:`, e);
          });
        }

        return await reply.code(200).send({
          status: "ok",
          triggered: true,
          matchingEvents: matchingLogs.length,
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
