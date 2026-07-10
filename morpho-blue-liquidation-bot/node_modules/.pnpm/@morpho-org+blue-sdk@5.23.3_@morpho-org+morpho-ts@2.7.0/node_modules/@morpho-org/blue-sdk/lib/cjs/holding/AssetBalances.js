"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssetBalances = void 0;
class AssetBalances {
    /**
     * The total balance of all types of related tokens.
     */
    total;
    /**
     * The balance of each type of related tokens and the corresponding underlying balance.
     */
    allocations;
    constructor(balance) {
        this.total = balance.dstAmount;
        this.allocations = {
            base: { ...balance, type: "base" },
        };
    }
    add(balance) {
        this.total += balance.dstAmount;
        const allocation = (this.allocations[balance.type] ??= {
            ...balance,
            srcAmount: 0n,
            dstAmount: 0n,
        });
        allocation.srcAmount += balance.srcAmount;
        allocation.dstAmount += balance.dstAmount;
        return this;
    }
    sub(balance) {
        this.total -= balance.dstAmount;
        const allocation = (this.allocations[balance.type] ??= {
            ...balance,
            srcAmount: 0n,
            dstAmount: 0n,
        });
        allocation.srcAmount -= balance.srcAmount;
        allocation.dstAmount -= balance.dstAmount;
        return this;
    }
}
exports.AssetBalances = AssetBalances;
