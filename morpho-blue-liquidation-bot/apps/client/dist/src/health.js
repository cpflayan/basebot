import Fastify from "fastify";
class HealthServer {
    fastify;
    port;
    host;
    constructor(port = 3000, host = "127.0.0.1") {
        // SECURITY (L1): 預設綁定 localhost，避免暴露到外部網路
        this.port = port;
        this.host = host;
        this.fastify = Fastify({
            logger: false,
        });
        this.setupRoutes();
    }
    setupRoutes() {
        this.fastify.get("/health", async (request, reply) => {
            return reply.code(200).send({ status: "ok" });
        });
    }
    async start() {
        try {
            await this.fastify.listen({ port: this.port, host: this.host });
            console.log(`🚀 Health server listening on http://${this.host}:${this.port}`);
        }
        catch (err) {
            this.fastify.log.error(err);
            throw err;
        }
    }
    async stop() {
        await this.fastify.close();
    }
}
// Singleton instance
let healthServerInstance = null;
export function getHealthServer(port, host) {
    if (!healthServerInstance) {
        const serverPort = port ?? Number.parseInt(process.env.PORT ?? process.env.HEALTH_SERVER_PORT ?? "3000", 10);
        const serverHost = host ?? process.env.HEALTH_SERVER_HOST ?? "127.0.0.1"; // SECURITY (L1): 預設 localhost
        healthServerInstance = new HealthServer(serverPort, serverHost);
    }
    return healthServerInstance;
}
export async function startHealthServer(port, host) {
    const server = getHealthServer(port, host);
    await server.start();
    return server;
}
