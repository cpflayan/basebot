export class MorphoApi {
    API_URL = "https://blue-api.morpho.org/graphql";
    supportedChains = [];
    initialized = false;
    async price(client, asset) {
        if (!this.initialized) {
            await this.initialize();
        }
        if (!this.supportedChains.includes(client.chain.id))
            return;
        try {
            const response = await fetch(this.API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: this.query(client.chain.id, asset) }),
            });
            const data = (await response.json());
            const items = data.data.assets.items;
            const priceUsd = items.find((item) => item.address === asset)?.priceUsd ?? null;
            return priceUsd ?? undefined;
        }
        catch (error) {
            console.error(error);
            return undefined;
        }
    }
    async initialize() {
        const initilizationQuery = `
      query {
        chains{
            id
        }
      }
      `;
        try {
            const response = await fetch(this.API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: initilizationQuery }),
            });
            const data = (await response.json());
            this.supportedChains = data.data.chains.map((chain) => chain.id);
            this.initialized = true;
        }
        catch (error) {
            console.error(error);
        }
    }
    query(chainId, asset) {
        return `
    query {
        assets(where: { address_in: ["${asset}"], chainId_in: [${chainId}]} ) {
            items {
                address
                priceUsd
            }
        }
    }
    `;
    }
}
