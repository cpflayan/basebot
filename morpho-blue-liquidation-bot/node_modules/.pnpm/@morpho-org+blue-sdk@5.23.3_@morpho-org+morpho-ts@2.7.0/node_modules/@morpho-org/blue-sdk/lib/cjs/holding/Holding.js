"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Holding = exports.ERC20_ALLOWANCE_RECIPIENTS = void 0;
const morpho_ts_1 = require("@morpho-org/morpho-ts");
exports.ERC20_ALLOWANCE_RECIPIENTS = [
    "morpho",
    "permit2",
    "bundler3.generalAdapter1",
];
class Holding {
    /**
     * The user of this holding.
     */
    user;
    /**
     * The token in which this holding is denominated.
     */
    token;
    /**
     * Whether the user is allowed to transfer this holding's balance.
     */
    canTransfer;
    /**
     * ERC20 allowance for this token from the user to the allowance recipient.
     */
    erc20Allowances;
    /**
     * Permit2 allowance for this token from the user to the allowance recipient.
     */
    permit2BundlerAllowance;
    /**
     * ERC-2612 Permit nonce of the user for this token.
     * `undefined` if the token does not support ERC-2612.
     */
    erc2612Nonce;
    /**
     * Allows to customize the setter behavior in child classes.
     */
    _balance;
    constructor({ user, token, erc20Allowances, permit2BundlerAllowance, balance, erc2612Nonce, canTransfer, }) {
        this.user = user;
        this.token = token;
        this._balance = balance;
        this.canTransfer = canTransfer;
        this.erc20Allowances = (0, morpho_ts_1.fromEntries)((0, morpho_ts_1.entries)(erc20Allowances).map(([address, allowance]) => [
            address,
            allowance,
        ]));
        this.permit2BundlerAllowance = {
            amount: BigInt(permit2BundlerAllowance.amount),
            expiration: BigInt(permit2BundlerAllowance.expiration),
            nonce: BigInt(permit2BundlerAllowance.nonce),
        };
        if (erc2612Nonce != null)
            this.erc2612Nonce = erc2612Nonce;
    }
    /**
     * The balance of the user for this token.
     */
    get balance() {
        return this._balance;
    }
    set balance(value) {
        this._balance = value;
    }
}
exports.Holding = Holding;
