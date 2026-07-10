import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHealthServer } from "../../src/health.js";
describe("Health endpoint", () => {
    let healthServer;
    let port;
    beforeAll(async () => {
        // Use a random port for testing to avoid conflicts
        port = 3001;
        healthServer = await startHealthServer(port, "127.0.0.1");
    });
    afterAll(async () => {
        await healthServer.stop();
    });
    it("should return 200 with status ok", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        const data = await response.json();
        expect(data).toEqual({ status: "ok" });
    });
});
