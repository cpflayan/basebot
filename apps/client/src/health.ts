import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

export interface BotHealthStatus {
  protocol: "morpho" | "comet" | "moonwell" | "aave";
  lastCheckTimestamp: number;
  lastCheckBlock: number;
  registryAccountCount: number;
  liquidationsAttempted: number;
  liquidationsSucceeded: number;
  liquidationsFailed: number;
  rpcErrorRate: number;
  lastError?: string;
  isHealthy: boolean;
}

type StatusFn = () => BotHealthStatus;

class HealthServer {
  private fastify: FastifyInstance;
  private port: number;
  private host: string;
  private registeredBots = new Map<string, StatusFn>();

  constructor(port = 3000, host = "127.0.0.1") {
    // SECURITY (L1): 預設綁定 localhost，避免暴露到外部網路
    this.port = port;
    this.host = host;
    this.fastify = Fastify({
      logger: false,
    });

    this.setupRoutes();
  }

  /**
   * Register a bot's health status function.
   * The function will be called on each /health request to get live status.
   */
  registerBot(name: string, statusFn: StatusFn): void {
    this.registeredBots.set(name, statusFn);
  }

  private setupRoutes() {
    this.fastify.get("/health", async (_request, reply) => {
      const bots: Record<string, BotHealthStatus | { error: string }> = {};
      let allHealthy = true;

      for (const [name, statusFn] of this.registeredBots) {
        try {
          const status = statusFn();
          bots[name] = status;
          if (!status.isHealthy) allHealthy = false;
        } catch (e) {
          bots[name] = { error: String(e) };
          allHealthy = false;
        }
      }

      // If no bots registered, return simple ok
      if (this.registeredBots.size === 0) {
        return reply.code(200).send({ status: "ok" });
      }

      return reply.code(200).send({
        status: allHealthy ? "healthy" : "degraded",
        bots,
      });
    });

    // Per-bot health endpoint: /health/:name
    this.fastify.get<{ Params: { name: string } }>("/health/:name", async (request, reply) => {
      const { name } = request.params;
      const statusFn = this.registeredBots.get(name);
      if (!statusFn) {
        return reply.code(404).send({ error: `Bot '${name}' not found` });
      }
      try {
        return await reply.code(200).send(statusFn());
      } catch (e) {
        return reply.code(500).send({ error: String(e) });
      }
    });
  }

  async start() {
    try {
      await this.fastify.listen({ port: this.port, host: this.host });
      console.log(`🚀 Health server listening on http://${this.host}:${this.port}`);
    } catch (err) {
      this.fastify.log.error(err);
      throw err;
    }
  }

  async stop() {
    await this.fastify.close();
  }
}

// Singleton instance
let healthServerInstance: HealthServer | null = null;

export function getHealthServer(port?: number, host?: string): HealthServer {
  if (!healthServerInstance) {
    const serverPort =
      port ?? Number.parseInt(process.env.PORT ?? process.env.HEALTH_SERVER_PORT ?? "3000", 10);
    const serverHost = host ?? process.env.HEALTH_SERVER_HOST ?? "127.0.0.1"; // SECURITY (L1): 預設 localhost
    healthServerInstance = new HealthServer(serverPort, serverHost);
  }
  return healthServerInstance;
}

export async function startHealthServer(port?: number, host?: string): Promise<HealthServer> {
  const server = getHealthServer(port, host);
  await server.start();
  return server;
}
