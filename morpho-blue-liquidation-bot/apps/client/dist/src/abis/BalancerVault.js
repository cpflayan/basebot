/**
 * Balancer V2 Vault ABI — flash loan functions only.
 * Vault address on Base: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 */
export const balancerVaultAbi = [
    {
        inputs: [
            { internalType: "contract IFlashLoanRecipient", name: "recipient", type: "address" },
            { internalType: "contract IERC20[]", name: "tokens", type: "address[]" },
            { internalType: "uint256[]", name: "amounts", type: "uint256[]" },
            { internalType: "bytes", name: "userData", type: "bytes" },
        ],
        name: "flashLoan",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "contract IERC20", name: "token", type: "address" }],
        name: "getProtocolFeesCollector",
        outputs: [{ internalType: "contract IProtocolFeesCollector", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
];
/**
 * IFlashLoanRecipient interface — the callback the Vault invokes.
 */
export const flashLoanRecipientAbi = [
    {
        inputs: [
            { internalType: "address[]", name: "tokens", type: "address[]" },
            { internalType: "uint256[]", name: "amounts", type: "uint256[]" },
            { internalType: "uint256[]", name: "feeAmounts", type: "uint256[]" },
            { internalType: "bytes", name: "userData", type: "bytes" },
        ],
        name: "receiveFlashLoan",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
];
/**
 * Balancer V2 Vault constants.
 */
export const BALANCER_VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
/**
 * Balancer flash loan fee — 0%.
 */
export const BALANCER_FLASH_LOAN_FEE_BPS = 0n;
