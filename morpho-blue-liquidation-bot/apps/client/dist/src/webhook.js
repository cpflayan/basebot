import Fastify from "fastify";
import { toEventSelector } from "viem";
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
];
export class WebhookServer {
    fastify;
    port;
    host;
    bots = [];
    topic0Set;
    lastTriggerTime = 0;
    /** Minimum interval between webhook-triggered runs (ms) */
    cooldownMs;
    constructor(port = 3001, host = "0.0.0.0", cooldownMs = 2000) {
        this.port = port;
        this.host = host;
        this.cooldownMs = cooldownMs;
        // Pre-compute topic0 hashes from event signatures
        this.topic0Set = new Set(MORPHO_EVENT_SIGNATURES.map((sig) => toEventSelector(sig)));
        this.fastify = Fastify({ logger: false });
        this.setupRoutes();
    }
    setupRoutes() {
        // Alchemy sends POST to this endpoint
        this.fastify.post("/webhook", async (request, reply) => {
            try {
                const body = request.body;
                const logs = body?.event?.data;
                const logArray = logs?.block;
                const logsList = logArray?.logs;
                if (!Array.isArray(logsList)) {
                    return await reply.code(200).send({ status: "ok", triggered: false, reason: "no logs" });
                }
                // Filter for relevant Morpho events
                const matchingLogs = logsList.filter((log) => {
                    const topics = log.topics;
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
                console.log(`[Webhook] ${matchingLogs.length} Morpho event(s) detected, triggering ${this.bots.length} bot(s)`);
                for (const { bot, logTag } of this.bots) {
                    bot.run().catch((e) => {
                        console.error(`${logTag} webhook-triggered run failed:`, e);
                    });
                }
                return await reply.code(200).send({
                    status: "ok",
                    triggered: true,
                    matchingEvents: matchingLogs.length,
                });
            }
            catch (error) {
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
    registerBot(bot, logTag) {
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
