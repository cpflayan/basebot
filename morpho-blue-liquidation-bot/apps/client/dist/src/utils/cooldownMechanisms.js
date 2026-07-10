export class PositionLiquidationCooldownMechanism {
    cooldownPeriod;
    positionReadyAt;
    constructor(cooldownPeriod) {
        this.cooldownPeriod = cooldownPeriod;
        this.positionReadyAt = {};
    }
    isPositionReady(marketId, account) {
        if (this.positionReadyAt[marketId] === undefined) {
            this.positionReadyAt[marketId] = {};
        }
        if (this.positionReadyAt[marketId][account] === undefined) {
            this.positionReadyAt[marketId][account] = 0;
        }
        if (this.positionReadyAt[marketId][account] > Math.floor(Date.now() / 1000)) {
            return false;
        }
        this.positionReadyAt[marketId][account] = Math.floor(Date.now() / 1000) + this.cooldownPeriod;
        return true;
    }
}
export class MarketsFetchingCooldownMechanism {
    cooldownPeriod;
    readyAt;
    constructor(cooldownPeriod) {
        this.cooldownPeriod = cooldownPeriod;
        this.readyAt = 0;
    }
    isFetchingReady() {
        if (this.readyAt > Math.floor(Date.now() / 1000)) {
            return false;
        }
        this.readyAt = Math.floor(Date.now() / 1000) + this.cooldownPeriod;
        return true;
    }
}
