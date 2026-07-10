export declare const feedRegistryAbi: readonly [{
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "accessController";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }];
    readonly name: "AccessControllerSet";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "denomination";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "latestAggregator";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "previousAggregator";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "uint16";
        readonly name: "nextPhaseId";
        readonly type: "uint16";
    }, {
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }];
    readonly name: "FeedConfirmed";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "denomination";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "proposedAggregator";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "currentAggregator";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "sender";
        readonly type: "address";
    }];
    readonly name: "FeedProposed";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }];
    readonly name: "OwnershipTransferRequested";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly indexed: true;
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }];
    readonly name: "OwnershipTransferred";
    readonly type: "event";
}, {
    readonly inputs: readonly [];
    readonly name: "acceptOwnership";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "aggregator";
        readonly type: "address";
    }];
    readonly name: "confirmFeed";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "decimals";
    readonly outputs: readonly [{
        readonly internalType: "uint8";
        readonly name: "";
        readonly type: "uint8";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "description";
    readonly outputs: readonly [{
        readonly internalType: "string";
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "getAccessController";
    readonly outputs: readonly [{
        readonly internalType: "contract AccessControllerInterface";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "roundId";
        readonly type: "uint256";
    }];
    readonly name: "getAnswer";
    readonly outputs: readonly [{
        readonly internalType: "int256";
        readonly name: "answer";
        readonly type: "int256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "getCurrentPhaseId";
    readonly outputs: readonly [{
        readonly internalType: "uint16";
        readonly name: "currentPhaseId";
        readonly type: "uint16";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "getFeed";
    readonly outputs: readonly [{
        readonly internalType: "contract AggregatorV2V3Interface";
        readonly name: "aggregator";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint80";
        readonly name: "roundId";
        readonly type: "uint80";
    }];
    readonly name: "getNextRoundId";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "nextRoundId";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint16";
        readonly name: "phaseId";
        readonly type: "uint16";
    }];
    readonly name: "getPhase";
    readonly outputs: readonly [{
        readonly components: readonly [{
            readonly internalType: "uint16";
            readonly name: "phaseId";
            readonly type: "uint16";
        }, {
            readonly internalType: "uint80";
            readonly name: "startingAggregatorRoundId";
            readonly type: "uint80";
        }, {
            readonly internalType: "uint80";
            readonly name: "endingAggregatorRoundId";
            readonly type: "uint80";
        }];
        readonly internalType: "struct FeedRegistryInterface.Phase";
        readonly name: "phase";
        readonly type: "tuple";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint16";
        readonly name: "phaseId";
        readonly type: "uint16";
    }];
    readonly name: "getPhaseFeed";
    readonly outputs: readonly [{
        readonly internalType: "contract AggregatorV2V3Interface";
        readonly name: "aggregator";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint16";
        readonly name: "phaseId";
        readonly type: "uint16";
    }];
    readonly name: "getPhaseRange";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "startingRoundId";
        readonly type: "uint80";
    }, {
        readonly internalType: "uint80";
        readonly name: "endingRoundId";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint80";
        readonly name: "roundId";
        readonly type: "uint80";
    }];
    readonly name: "getPreviousRoundId";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "previousRoundId";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "getProposedFeed";
    readonly outputs: readonly [{
        readonly internalType: "contract AggregatorV2V3Interface";
        readonly name: "proposedAggregator";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint80";
        readonly name: "_roundId";
        readonly type: "uint80";
    }];
    readonly name: "getRoundData";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "roundId";
        readonly type: "uint80";
    }, {
        readonly internalType: "int256";
        readonly name: "answer";
        readonly type: "int256";
    }, {
        readonly internalType: "uint256";
        readonly name: "startedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint80";
        readonly name: "answeredInRound";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint80";
        readonly name: "roundId";
        readonly type: "uint80";
    }];
    readonly name: "getRoundFeed";
    readonly outputs: readonly [{
        readonly internalType: "contract AggregatorV2V3Interface";
        readonly name: "aggregator";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "roundId";
        readonly type: "uint256";
    }];
    readonly name: "getTimestamp";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "timestamp";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "aggregator";
        readonly type: "address";
    }];
    readonly name: "isFeedEnabled";
    readonly outputs: readonly [{
        readonly internalType: "bool";
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "latestAnswer";
    readonly outputs: readonly [{
        readonly internalType: "int256";
        readonly name: "answer";
        readonly type: "int256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "latestRound";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "roundId";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "latestRoundData";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "roundId";
        readonly type: "uint80";
    }, {
        readonly internalType: "int256";
        readonly name: "answer";
        readonly type: "int256";
    }, {
        readonly internalType: "uint256";
        readonly name: "startedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint80";
        readonly name: "answeredInRound";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "latestTimestamp";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "timestamp";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
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
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "aggregator";
        readonly type: "address";
    }];
    readonly name: "proposeFeed";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly internalType: "uint80";
        readonly name: "roundId";
        readonly type: "uint80";
    }];
    readonly name: "proposedGetRoundData";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "id";
        readonly type: "uint80";
    }, {
        readonly internalType: "int256";
        readonly name: "answer";
        readonly type: "int256";
    }, {
        readonly internalType: "uint256";
        readonly name: "startedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint80";
        readonly name: "answeredInRound";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "proposedLatestRoundData";
    readonly outputs: readonly [{
        readonly internalType: "uint80";
        readonly name: "id";
        readonly type: "uint80";
    }, {
        readonly internalType: "int256";
        readonly name: "answer";
        readonly type: "int256";
    }, {
        readonly internalType: "uint256";
        readonly name: "startedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint256";
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly internalType: "uint80";
        readonly name: "answeredInRound";
        readonly type: "uint80";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "contract AccessControllerInterface";
        readonly name: "_accessController";
        readonly type: "address";
    }];
    readonly name: "setAccessController";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "to";
        readonly type: "address";
    }];
    readonly name: "transferOwnership";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "typeAndVersion";
    readonly outputs: readonly [{
        readonly internalType: "string";
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "pure";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly name: "version";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
