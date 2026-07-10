export declare const uniswapV4PoolManagerAbi: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "initialOwner";
        readonly type: "address";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "constructor";
}, {
    readonly inputs: readonly [];
    readonly name: "AlreadyUnlocked";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "currency0";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "currency1";
        readonly type: "address";
    }];
    readonly name: "CurrenciesOutOfOrderOrEqual";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "CurrencyNotSettled";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "DelegateCallNotAllowed";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InvalidCaller";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "ManagerLocked";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "MustClearExactPositiveDelta";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "NonzeroNativeValue";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "PoolNotInitialized";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "ProtocolFeeCurrencySynced";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint24";
        readonly name: "fee";
        readonly type: "uint24";
    }];
    readonly name: "ProtocolFeeTooLarge";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "SwapAmountCannotBeZero";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "int24";
        readonly name: "tickSpacing";
        readonly type: "int24";
    }];
    readonly name: "TickSpacingTooLarge";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "int24";
        readonly name: "tickSpacing";
        readonly type: "int24";
    }];
    readonly name: "TickSpacingTooSmall";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "UnauthorizedDynamicLPFeeUpdate";
    readonly type: "error";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "Approval";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "PoolId";
        readonly name: "id";
        readonly type: "bytes32";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "amount1";
        readonly type: "uint256";
    }];
    readonly name: "Donate";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "PoolId";
        readonly name: "id";
        readonly type: "bytes32";
    }, {
        readonly indexed: true;
        readonly internalType: "Currency";
        readonly name: "currency0";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "Currency";
        readonly name: "currency1";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "uint24";
        readonly name: "fee";
        readonly type: "uint24";
    }, {
        readonly indexed: false;
        readonly internalType: "int24";
        readonly name: "tickSpacing";
        readonly type: "int24";
    }, {
        readonly indexed: false;
        readonly internalType: "contract IHooks";
        readonly name: "hooks";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "uint160";
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }, {
        readonly indexed: false;
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }];
    readonly name: "Initialize";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "PoolId";
        readonly name: "id";
        readonly type: "bytes32";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "int24";
        readonly name: "tickLower";
        readonly type: "int24";
    }, {
        readonly indexed: false;
        readonly internalType: "int24";
        readonly name: "tickUpper";
        readonly type: "int24";
    }, {
        readonly indexed: false;
        readonly internalType: "int256";
        readonly name: "liquidityDelta";
        readonly type: "int256";
    }, {
        readonly indexed: false;
        readonly internalType: "bytes32";
        readonly name: "salt";
        readonly type: "bytes32";
    }];
    readonly name: "ModifyLiquidity";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "operator";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "bool";
        readonly name: "approved";
        readonly type: "bool";
    }];
    readonly name: "OperatorSet";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "user";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "newOwner";
        readonly type: "address";
    }];
    readonly name: "OwnershipTransferred";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "protocolFeeController";
        readonly type: "address";
    }];
    readonly name: "ProtocolFeeControllerUpdated";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "PoolId";
        readonly name: "id";
        readonly type: "bytes32";
    }, {
        readonly indexed: false;
        readonly internalType: "uint24";
        readonly name: "protocolFee";
        readonly type: "uint24";
    }];
    readonly name: "ProtocolFeeUpdated";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "PoolId";
        readonly name: "id";
        readonly type: "bytes32";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "int128";
        readonly name: "amount0";
        readonly type: "int128";
    }, {
        readonly indexed: false;
        readonly internalType: "int128";
        readonly name: "amount1";
        readonly type: "int128";
    }, {
        readonly indexed: false;
        readonly internalType: "uint160";
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }, {
        readonly indexed: false;
        readonly internalType: "uint128";
        readonly name: "liquidity";
        readonly type: "uint128";
    }, {
        readonly indexed: false;
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }, {
        readonly indexed: false;
        readonly internalType: "uint24";
        readonly name: "fee";
        readonly type: "uint24";
    }];
    readonly name: "Swap";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "caller";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "Transfer";
    readonly type: "event";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }];
    readonly name: "allowance";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "approve";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }];
    readonly name: "balanceOf";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "balance";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "burn";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "clear";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "collectProtocolFees";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amountCollected";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly internalType: "Currency";
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly internalType: "uint24";
            readonly name: "fee";
            readonly type: "uint24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickSpacing";
            readonly type: "int24";
        }, {
            readonly internalType: "contract IHooks";
            readonly name: "hooks";
            readonly type: "address";
        }];
        readonly internalType: "struct PoolKey";
        readonly name: "key";
        readonly type: "tuple";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount1";
        readonly type: "uint256";
    }, {
        readonly internalType: "bytes";
        readonly name: "hookData";
        readonly type: "bytes";
    }];
    readonly name: "donate";
    readonly outputs: readonly [{
        readonly internalType: "BalanceDelta";
        readonly name: "delta";
        readonly type: "int256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "slot";
        readonly type: "bytes32";
    }];
    readonly name: "extsload";
    readonly outputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "startSlot";
        readonly type: "bytes32";
    }, {
        readonly internalType: "uint256";
        readonly name: "nSlots";
        readonly type: "uint256";
    }];
    readonly name: "extsload";
    readonly outputs: readonly [{
        readonly internalType: "bytes32[]";
        readonly name: "";
        readonly type: "bytes32[]";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32[]";
        readonly name: "slots";
        readonly type: "bytes32[]";
    }];
    readonly name: "extsload";
    readonly outputs: readonly [{
        readonly internalType: "bytes32[]";
        readonly name: "";
        readonly type: "bytes32[]";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32[]";
        readonly name: "slots";
        readonly type: "bytes32[]";
    }];
    readonly name: "exttload";
    readonly outputs: readonly [{
        readonly internalType: "bytes32[]";
        readonly name: "";
        readonly type: "bytes32[]";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "slot";
        readonly type: "bytes32";
    }];
    readonly name: "exttload";
    readonly outputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly internalType: "Currency";
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly internalType: "uint24";
            readonly name: "fee";
            readonly type: "uint24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickSpacing";
            readonly type: "int24";
        }, {
            readonly internalType: "contract IHooks";
            readonly name: "hooks";
            readonly type: "address";
        }];
        readonly internalType: "struct PoolKey";
        readonly name: "key";
        readonly type: "tuple";
    }, {
        readonly internalType: "uint160";
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }];
    readonly name: "initialize";
    readonly outputs: readonly [{
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "operator";
        readonly type: "address";
    }];
    readonly name: "isOperator";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "isOperator";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "mint";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly internalType: "Currency";
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly internalType: "uint24";
            readonly name: "fee";
            readonly type: "uint24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickSpacing";
            readonly type: "int24";
        }, {
            readonly internalType: "contract IHooks";
            readonly name: "hooks";
            readonly type: "address";
        }];
        readonly internalType: "struct PoolKey";
        readonly name: "key";
        readonly type: "tuple";
    }, {
        readonly components: readonly [{
            readonly internalType: "int24";
            readonly name: "tickLower";
            readonly type: "int24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickUpper";
            readonly type: "int24";
        }, {
            readonly internalType: "int256";
            readonly name: "liquidityDelta";
            readonly type: "int256";
        }, {
            readonly internalType: "bytes32";
            readonly name: "salt";
            readonly type: "bytes32";
        }];
        readonly internalType: "struct IPoolManager.ModifyLiquidityParams";
        readonly name: "params";
        readonly type: "tuple";
    }, {
        readonly internalType: "bytes";
        readonly name: "hookData";
        readonly type: "bytes";
    }];
    readonly name: "modifyLiquidity";
    readonly outputs: readonly [{
        readonly internalType: "BalanceDelta";
        readonly name: "callerDelta";
        readonly type: "int256";
    }, {
        readonly internalType: "BalanceDelta";
        readonly name: "feesAccrued";
        readonly type: "int256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "owner";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "protocolFeeController";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }];
    readonly name: "protocolFeesAccrued";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "operator";
        readonly type: "address";
    }, {
        readonly internalType: "bool";
        readonly name: "approved";
        readonly type: "bool";
    }];
    readonly name: "setOperator";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly internalType: "Currency";
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly internalType: "uint24";
            readonly name: "fee";
            readonly type: "uint24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickSpacing";
            readonly type: "int24";
        }, {
            readonly internalType: "contract IHooks";
            readonly name: "hooks";
            readonly type: "address";
        }];
        readonly internalType: "struct PoolKey";
        readonly name: "key";
        readonly type: "tuple";
    }, {
        readonly internalType: "uint24";
        readonly name: "newProtocolFee";
        readonly type: "uint24";
    }];
    readonly name: "setProtocolFee";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "controller";
        readonly type: "address";
    }];
    readonly name: "setProtocolFeeController";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "settle";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "payable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "recipient";
        readonly type: "address";
    }];
    readonly name: "settleFor";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "payable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes4";
        readonly name: "interfaceId";
        readonly type: "bytes4";
    }];
    readonly name: "supportsInterface";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly internalType: "Currency";
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly internalType: "uint24";
            readonly name: "fee";
            readonly type: "uint24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickSpacing";
            readonly type: "int24";
        }, {
            readonly internalType: "contract IHooks";
            readonly name: "hooks";
            readonly type: "address";
        }];
        readonly internalType: "struct PoolKey";
        readonly name: "key";
        readonly type: "tuple";
    }, {
        readonly components: readonly [{
            readonly internalType: "bool";
            readonly name: "zeroForOne";
            readonly type: "bool";
        }, {
            readonly internalType: "int256";
            readonly name: "amountSpecified";
            readonly type: "int256";
        }, {
            readonly internalType: "uint160";
            readonly name: "sqrtPriceLimitX96";
            readonly type: "uint160";
        }];
        readonly internalType: "struct IPoolManager.SwapParams";
        readonly name: "params";
        readonly type: "tuple";
    }, {
        readonly internalType: "bytes";
        readonly name: "hookData";
        readonly type: "bytes";
    }];
    readonly name: "swap";
    readonly outputs: readonly [{
        readonly internalType: "BalanceDelta";
        readonly name: "swapDelta";
        readonly type: "int256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }];
    readonly name: "sync";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "take";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "transfer";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "transferFrom";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "newOwner";
        readonly type: "address";
    }];
    readonly name: "transferOwnership";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly name: "unlock";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "result";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly internalType: "Currency";
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly internalType: "uint24";
            readonly name: "fee";
            readonly type: "uint24";
        }, {
            readonly internalType: "int24";
            readonly name: "tickSpacing";
            readonly type: "int24";
        }, {
            readonly internalType: "contract IHooks";
            readonly name: "hooks";
            readonly type: "address";
        }];
        readonly internalType: "struct PoolKey";
        readonly name: "key";
        readonly type: "tuple";
    }, {
        readonly internalType: "uint24";
        readonly name: "newDynamicLPFee";
        readonly type: "uint24";
    }];
    readonly name: "updateDynamicLPFee";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
export declare const uniswapV4QuoterAbi: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "contract IPoolManager";
        readonly name: "_poolManager";
        readonly type: "address";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "constructor";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }];
    readonly name: "NotEnoughLiquidity";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "NotPoolManager";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "NotSelf";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "QuoteSwap";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "UnexpectedCallSuccess";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "revertData";
        readonly type: "bytes";
    }];
    readonly name: "UnexpectedRevertBytes";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "exactCurrency";
            readonly type: "address";
        }, {
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "intermediateCurrency";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }, {
                readonly internalType: "bytes";
                readonly name: "hookData";
                readonly type: "bytes";
            }];
            readonly internalType: "struct PathKey[]";
            readonly name: "path";
            readonly type: "tuple[]";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "_quoteExactInput";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "currency0";
                readonly type: "address";
            }, {
                readonly internalType: "Currency";
                readonly name: "currency1";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }];
            readonly internalType: "struct PoolKey";
            readonly name: "poolKey";
            readonly type: "tuple";
        }, {
            readonly internalType: "bool";
            readonly name: "zeroForOne";
            readonly type: "bool";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }, {
            readonly internalType: "bytes";
            readonly name: "hookData";
            readonly type: "bytes";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactSingleParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "_quoteExactInputSingle";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "exactCurrency";
            readonly type: "address";
        }, {
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "intermediateCurrency";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }, {
                readonly internalType: "bytes";
                readonly name: "hookData";
                readonly type: "bytes";
            }];
            readonly internalType: "struct PathKey[]";
            readonly name: "path";
            readonly type: "tuple[]";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "_quoteExactOutput";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "currency0";
                readonly type: "address";
            }, {
                readonly internalType: "Currency";
                readonly name: "currency1";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }];
            readonly internalType: "struct PoolKey";
            readonly name: "poolKey";
            readonly type: "tuple";
        }, {
            readonly internalType: "bool";
            readonly name: "zeroForOne";
            readonly type: "bool";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }, {
            readonly internalType: "bytes";
            readonly name: "hookData";
            readonly type: "bytes";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactSingleParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "_quoteExactOutputSingle";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "poolManager";
    readonly outputs: readonly [{
        readonly internalType: "contract IPoolManager";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "exactCurrency";
            readonly type: "address";
        }, {
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "intermediateCurrency";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }, {
                readonly internalType: "bytes";
                readonly name: "hookData";
                readonly type: "bytes";
            }];
            readonly internalType: "struct PathKey[]";
            readonly name: "path";
            readonly type: "tuple[]";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "quoteExactInput";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "gasEstimate";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "currency0";
                readonly type: "address";
            }, {
                readonly internalType: "Currency";
                readonly name: "currency1";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }];
            readonly internalType: "struct PoolKey";
            readonly name: "poolKey";
            readonly type: "tuple";
        }, {
            readonly internalType: "bool";
            readonly name: "zeroForOne";
            readonly type: "bool";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }, {
            readonly internalType: "bytes";
            readonly name: "hookData";
            readonly type: "bytes";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactSingleParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "quoteExactInputSingle";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "gasEstimate";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "Currency";
            readonly name: "exactCurrency";
            readonly type: "address";
        }, {
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "intermediateCurrency";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }, {
                readonly internalType: "bytes";
                readonly name: "hookData";
                readonly type: "bytes";
            }];
            readonly internalType: "struct PathKey[]";
            readonly name: "path";
            readonly type: "tuple[]";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "quoteExactOutput";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amountIn";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "gasEstimate";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly components: readonly [{
                readonly internalType: "Currency";
                readonly name: "currency0";
                readonly type: "address";
            }, {
                readonly internalType: "Currency";
                readonly name: "currency1";
                readonly type: "address";
            }, {
                readonly internalType: "uint24";
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly internalType: "int24";
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly internalType: "contract IHooks";
                readonly name: "hooks";
                readonly type: "address";
            }];
            readonly internalType: "struct PoolKey";
            readonly name: "poolKey";
            readonly type: "tuple";
        }, {
            readonly internalType: "bool";
            readonly name: "zeroForOne";
            readonly type: "bool";
        }, {
            readonly internalType: "uint128";
            readonly name: "exactAmount";
            readonly type: "uint128";
        }, {
            readonly internalType: "bytes";
            readonly name: "hookData";
            readonly type: "bytes";
        }];
        readonly internalType: "struct IV4Quoter.QuoteExactSingleParams";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly name: "quoteExactOutputSingle";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "amountIn";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "gasEstimate";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly name: "unlockCallback";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}];
export declare const uniswapV4StateViewAbi: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "contract IPoolManager";
        readonly name: "_poolManager";
        readonly type: "address";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "constructor";
}, {
    readonly inputs: readonly [];
    readonly name: "NotPoolManager";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }];
    readonly name: "getFeeGrowthGlobals";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "feeGrowthGlobal0";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthGlobal1";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "int24";
        readonly name: "tickLower";
        readonly type: "int24";
    }, {
        readonly internalType: "int24";
        readonly name: "tickUpper";
        readonly type: "int24";
    }];
    readonly name: "getFeeGrowthInside";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "feeGrowthInside0X128";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthInside1X128";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }];
    readonly name: "getLiquidity";
    readonly outputs: readonly [{
        readonly internalType: "uint128";
        readonly name: "liquidity";
        readonly type: "uint128";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "bytes32";
        readonly name: "positionId";
        readonly type: "bytes32";
    }];
    readonly name: "getPositionInfo";
    readonly outputs: readonly [{
        readonly internalType: "uint128";
        readonly name: "liquidity";
        readonly type: "uint128";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthInside0LastX128";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthInside1LastX128";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "address";
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly internalType: "int24";
        readonly name: "tickLower";
        readonly type: "int24";
    }, {
        readonly internalType: "int24";
        readonly name: "tickUpper";
        readonly type: "int24";
    }, {
        readonly internalType: "bytes32";
        readonly name: "salt";
        readonly type: "bytes32";
    }];
    readonly name: "getPositionInfo";
    readonly outputs: readonly [{
        readonly internalType: "uint128";
        readonly name: "liquidity";
        readonly type: "uint128";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthInside0LastX128";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthInside1LastX128";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "bytes32";
        readonly name: "positionId";
        readonly type: "bytes32";
    }];
    readonly name: "getPositionLiquidity";
    readonly outputs: readonly [{
        readonly internalType: "uint128";
        readonly name: "liquidity";
        readonly type: "uint128";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }];
    readonly name: "getSlot0";
    readonly outputs: readonly [{
        readonly internalType: "uint160";
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }, {
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }, {
        readonly internalType: "uint24";
        readonly name: "protocolFee";
        readonly type: "uint24";
    }, {
        readonly internalType: "uint24";
        readonly name: "lpFee";
        readonly type: "uint24";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "int16";
        readonly name: "tick";
        readonly type: "int16";
    }];
    readonly name: "getTickBitmap";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tickBitmap";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }];
    readonly name: "getTickFeeGrowthOutside";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "feeGrowthOutside0X128";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthOutside1X128";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }];
    readonly name: "getTickInfo";
    readonly outputs: readonly [{
        readonly internalType: "uint128";
        readonly name: "liquidityGross";
        readonly type: "uint128";
    }, {
        readonly internalType: "int128";
        readonly name: "liquidityNet";
        readonly type: "int128";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthOutside0X128";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "feeGrowthOutside1X128";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "PoolId";
        readonly name: "poolId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "int24";
        readonly name: "tick";
        readonly type: "int24";
    }];
    readonly name: "getTickLiquidity";
    readonly outputs: readonly [{
        readonly internalType: "uint128";
        readonly name: "liquidityGross";
        readonly type: "uint128";
    }, {
        readonly internalType: "int128";
        readonly name: "liquidityNet";
        readonly type: "int128";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "poolManager";
    readonly outputs: readonly [{
        readonly internalType: "contract IPoolManager";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
export declare const uniswapUniversalRouterAbi: readonly [{
    readonly inputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "address";
            readonly name: "permit2";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "weth9";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "v2Factory";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "v3Factory";
            readonly type: "address";
        }, {
            readonly internalType: "bytes32";
            readonly name: "pairInitCodeHash";
            readonly type: "bytes32";
        }, {
            readonly internalType: "bytes32";
            readonly name: "poolInitCodeHash";
            readonly type: "bytes32";
        }, {
            readonly internalType: "address";
            readonly name: "v4PoolManager";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "v3NFTPositionManager";
            readonly type: "address";
        }, {
            readonly internalType: "address";
            readonly name: "v4PositionManager";
            readonly type: "address";
        }];
        readonly internalType: "struct RouterParameters";
        readonly name: "params";
        readonly type: "tuple";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "constructor";
}, {
    readonly inputs: readonly [];
    readonly name: "BalanceTooLow";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "ContractLocked";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }];
    readonly name: "DeltaNotNegative";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "Currency";
        readonly name: "currency";
        readonly type: "address";
    }];
    readonly name: "DeltaNotPositive";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "ETHNotAccepted";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "commandIndex";
        readonly type: "uint256";
    }, {
        readonly internalType: "bytes";
        readonly name: "message";
        readonly type: "bytes";
    }];
    readonly name: "ExecutionFailed";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "FromAddressIsNotOwner";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InputLengthMismatch";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InsufficientBalance";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InsufficientETH";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InsufficientToken";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes4";
        readonly name: "action";
        readonly type: "bytes4";
    }];
    readonly name: "InvalidAction";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InvalidBips";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "commandType";
        readonly type: "uint256";
    }];
    readonly name: "InvalidCommandType";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InvalidEthSender";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InvalidPath";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "InvalidReserves";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "LengthMismatch";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "tokenId";
        readonly type: "uint256";
    }];
    readonly name: "NotAuthorizedForToken";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "NotPoolManager";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "OnlyMintAllowed";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "SliceOutOfBounds";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "TransactionDeadlinePassed";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "UnsafeCast";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "action";
        readonly type: "uint256";
    }];
    readonly name: "UnsupportedAction";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V2InvalidPath";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V2TooLittleReceived";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V2TooMuchRequested";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V3InvalidAmountOut";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V3InvalidCaller";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V3InvalidSwap";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V3TooLittleReceived";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V3TooMuchRequested";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "minAmountOutReceived";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amountReceived";
        readonly type: "uint256";
    }];
    readonly name: "V4TooLittleReceived";
    readonly type: "error";
}, {
    readonly inputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "maxAmountInRequested";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "amountRequested";
        readonly type: "uint256";
    }];
    readonly name: "V4TooMuchRequested";
    readonly type: "error";
}, {
    readonly inputs: readonly [];
    readonly name: "V3_POSITION_MANAGER";
    readonly outputs: readonly [{
        readonly internalType: "contract INonfungiblePositionManager";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "V4_POSITION_MANAGER";
    readonly outputs: readonly [{
        readonly internalType: "contract IPositionManager";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "commands";
        readonly type: "bytes";
    }, {
        readonly internalType: "bytes[]";
        readonly name: "inputs";
        readonly type: "bytes[]";
    }];
    readonly name: "execute";
    readonly outputs: readonly [];
    readonly stateMutability: "payable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "commands";
        readonly type: "bytes";
    }, {
        readonly internalType: "bytes[]";
        readonly name: "inputs";
        readonly type: "bytes[]";
    }, {
        readonly internalType: "uint256";
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly name: "execute";
    readonly outputs: readonly [];
    readonly stateMutability: "payable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "msgSender";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "poolManager";
    readonly outputs: readonly [{
        readonly internalType: "contract IPoolManager";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "int256";
        readonly name: "amount0Delta";
        readonly type: "int256";
    }, {
        readonly internalType: "int256";
        readonly name: "amount1Delta";
        readonly type: "int256";
    }, {
        readonly internalType: "bytes";
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly name: "uniswapV3SwapCallback";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly name: "unlockCallback";
    readonly outputs: readonly [{
        readonly internalType: "bytes";
        readonly name: "";
        readonly type: "bytes";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly stateMutability: "payable";
    readonly type: "receive";
}];
