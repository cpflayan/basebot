export declare const aerodromeFactoryAbi: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "tokenB";
        readonly type: "address";
    }, {
        readonly internalType: "bool";
        readonly name: "stable";
        readonly type: "bool";
    }];
    readonly name: "getPool";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "pool";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
export declare const aerodromePoolAbi: readonly [{
    readonly inputs: readonly [];
    readonly name: "token0";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "token1";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "stable";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "getReserves";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "reserve0";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "reserve1";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "blockTimestampLast";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amount0Out";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount1Out";
        readonly type: "uint256";
    }, {
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly internalType: "bytes";
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly name: "swap";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
