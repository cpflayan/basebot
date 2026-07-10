export class DefiLlamaPricer {
    priceCache = new Map();
    cacheTimeoutMs = 10_000; // 10 seconds
    async price(client, asset) {
        const cacheKey = this.getCoinKey(client, asset);
        const cachedResult = this.priceCache.get(cacheKey);
        if (cachedResult && Date.now() - cachedResult.fetchTimestamp < this.cacheTimeoutMs) {
            return cachedResult.price;
        }
        const price = await this.fetchPrice(client, asset);
        return price;
    }
    async fetchPrice(client, asset) {
        const coinKey = this.getCoinKey(client, asset);
        const url = `https://coins.llama.fi/prices/current/${coinKey}`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                return undefined;
            }
            const data = (await response.json());
            const coinData = data.coins[coinKey];
            if (!coinData) {
                return undefined;
            }
            this.priceCache.set(coinKey, {
                price: coinData.price,
                fetchTimestamp: Date.now(),
                apiTimestamp: coinData.timestamp,
            });
            return coinData.price;
        }
        catch {
            return undefined;
        }
    }
    getCoinKey(client, asset) {
        return `${client.chain.name}:${asset}`;
    }
}
