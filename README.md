# Multi-Protocol Liquidation Bot

A simple, fast, and easily deployable liquidation bot for **Morpho Blue**, **Compound V3 (Comet)**, and **Moonwell (Compound V2)** lending protocols. This bot is entirely based on **RPC calls** and is designed to be **easy to configure**, **customizable**, and **ready to deploy** on any EVM-compatible chain.

## Features

- **Multi-protocol support**: Automatically detects and liquidates positions across three lending protocols:
  - **Morpho Blue**: Isolated lending markets with oracle-based pricing
  - **Compound V3 (Comet)**: Single borrowing market per Comet with absorb + buyCollateral
  - **Moonwell**: Compound V2 fork with liquidateBorrow + redeemUnderlying
- Multi-chain compatible.
- Modular architecture with pluggable [data providers](./apps/data-providers/README.md), [liquidity venues](./apps/liquidity-venues/README.md), and [pricers](./apps/pricers/README.md).
- Profit evaluation thanks to configurable pricers.
- **Flash loan support**: Balancer V2 (0% fee) and Aave V3 (0.05% fee) for capital-efficient liquidations.
- **Event-driven fast path** (Morpho only): Alchemy webhook integration for instant liquidation opportunities.
- **Dual-RPC architecture** (Comet & Moonwell): Base public RPC for historical scanning + Alchemy for trading.
- Minimal setup and dependencies (RPC-only, no extra infra required).

### ⚠️ Disclaimer

This bot is provided as-is, without any warranty. The **Morpho Association is not responsible** for any potential loss of funds resulting from the use of this bot, including (but not limited to) gas fees, failed transactions, or liquidations on malicious or misconfigured markets (although the market whitelisting mechanism is designed to protect against unsafe liquidations).

Use at your own risk.

## Packages

| Package                                            | Description                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| [`apps/config`](./apps/config)                     | Chain configurations, module registrations, and all tunable parameters   |
| [`apps/client`](./apps/client)                     | Bot orchestration, on-chain execution, and transaction management        |
| [`apps/data-providers`](./apps/data-providers)     | Data provider implementations for fetching market and position data      |
| [`apps/hyperindex`](./apps/hyperindex)             | Envio HyperIndex indexer for self-hosted on-chain data                   |
| [`apps/liquidity-venues`](./apps/liquidity-venues) | Liquidity venue implementations for converting collateral to loan tokens |
| [`apps/pricers`](./apps/pricers)                   | Pricer implementations for USD pricing and profitability checks          |

## Requirements

- Node.js >= 20
- [pnpm](https://pnpm.io/) (this repo uses `pnpm` as package manager)
- A valid RPC URL (via Alchemy, Infura, etc)
- The private key of an EOA with enough funds to pay for gas.
- An executor contract deployed for this EOA (see [Executor Contract Deployment](#executor-contract-deployment)).

## Installation

```bash
git clone https://github.com/morpho-org/morpho-blue-liquidation-bot.git
cd morpho-blue-liquidation-bot
pnpm install
```

## Chain Configuration

The bot can be configured to run on any EVM-compatible chain where the Morpho stack has been deployed. The chain configuration is done in the `apps/config/src/config.ts` file.

For each chain, here are the parameters that need to be configured:

### Chain Wrapped Native Asset

- `wNative`: The chain's wrapped native asset (ex: WETH's address on Ethereum mainnet).

### Options

- `options.dataProvider`: The [data provider](./apps/data-providers/README.md) to use for fetching market and position data. Currently supported: `"morphoApi"`, `"hyperIndex"`.

- `options.vaultWhitelist`: List of MetaMorpho vault addresses. All the markets listed by those vaults will be whitelisted. Can also be set to `"morpho-api"` to dynamically resolve whitelisted vaults.

- `options.additionalMarketsWhitelist`: List of market IDs to whitelist (even if they are not listed by any vault).

- `options.liquidityVenues`: Array of [liquidity venue](./apps/liquidity-venues/README.md) names. The order is the order in which venues will be tried.

- `options.pricers` (optional): Array of [pricer](./apps/pricers/README.md) names. The order is the fallback order when pricing assets. Leave undefined or empty to disable profit checks.

- `options.treasuryAddress` (optional): Address to receive liquidation profits. Defaults to the bot's EOA.

- `options.useFlashbots`: Set to `true` to use Flashbots (requires `FLASHBOTS_PRIVATE_KEY` env var).

- `options.liquidationBufferBps` (optional): Buffer in basis points to reduce seizable collateral, protecting against price movements before execution. Default: 10 bps. Not applied when realizing bad debt.

- `options.blockInterval` (optional): Run liquidation checks every N blocks. Default: every block.

- `options.watchBlocksRetryDelayMs` (optional): Delay in milliseconds before restarting the block watcher after an RPC error. Default: 5000.

- `options.useFlashLoan` (optional): Enable Balancer V2 flash loans for capital-efficient liquidations. Default: false.

- `options.flashLoanProvider` (optional): Flash loan provider — `"balancer"` (0% fee) or `"aave"` (0.05% fee). Default: `"balancer"`.

- `options.cometWatchlist` (optional): Compound V3 Comet market configuration. See [ARCHITECTURE.md](./ARCHITECTURE.md#compound-v3-configuration) for details.

- `options.moonwellWatchlist` (optional): Moonwell (Compound V2) market configuration. See [ARCHITECTURE.md](./ARCHITECTURE.md#moonwell-configuration) for details.

### Secrets

Secrets are set in the `.env` file at the root of the repository, with the following keys:

- `RPC_URL_<chainId>` — RPC URL for the chain.
- `EXECUTOR_ADDRESS_<chainId>` — Address of the deployed executor contract.
- `LIQUIDATION_PRIVATE_KEY_<chainId>` — Private key of the EOA.
- `FLASHBOTS_PRIVATE_KEY` (optional) — Flashbots private key, only if using Flashbots.

Example for mainnet (chainId 1):

```
RPC_URL_1=https://eth-mainnet.g.alchemy.com/v2/<your-api-key>
EXECUTOR_ADDRESS_1=0x...
LIQUIDATION_PRIVATE_KEY_1=0x...
```

### Cooldown Mechanisms

- `MARKETS_FETCHING_COOLDOWN_PERIOD`: Cooldown (in seconds) between vault market re-fetches. Configured in `apps/config/src/config.ts`.
- `POSITION_LIQUIDATION_COOLDOWN_ENABLED` / `POSITION_LIQUIDATION_COOLDOWN_PERIOD`: Optional cooldown before retrying a failed liquidation. Useful when venues rely on rate-limited APIs.

### Bad Debt Realization

Set `ALWAYS_REALIZE_BAD_DEBT` to `true` in `apps/config/src/config.ts` to always fully liquidate bad debt positions, even if not profitable.

## Executor Contract Deployment

The bot uses an executor contract to execute liquidations ([executor repository](https://github.com/Rubilmax/executooor)). These contracts are gated (only callable by the owner), so you need to deploy your own.

Set `RPC_URL_<chainId>` and `LIQUIDATION_PRIVATE_KEY_<chainId>` in `.env`, then:

```bash
pnpm deploy:executor
```

You can also deploy via [this interface](https://rubilmax.github.io/executooor/).

## Run the bot

```bash
pnpm liquidate
```

### Claim Profit

Liquidation profits are held by the Executor Contract. To transfer them:

```bash
pnpm skim --chainId 1 --token 0x... --recipient 0x...
```

- `chainId` (required): Chain ID where the tokens are held.
- `token` (required): Token address to claim.
- `recipient` (optional): Recipient address. Defaults to the bot's EOA.

## Liquidation Process

![Process](./img/liquidation-process-high-level.png)

### Morpho Blue Flow

1. **Slow path**: `watchBlocks` → `bot.run()` → fetch liquidatable positions from Morpho API → attempt liquidation
2. **Fast path**: Alchemy webhook → decode MorphoBlue events → update `PositionCache` → fetch fresh oracle price → recalculate HF → liquidate if HF < 1
3. For each position: try liquidity venues → simulate → check profit → execute via executor contract or Flashbots

### Compound V3 (Comet) Flow

1. **Account discovery**: `CometAccountRegistry` scans `SupplyCollateral`/`WithdrawCollateral` events to build account list
2. **Polling**: `watchBlocks` → batch `isLiquidatable()` checks → attempt liquidation
3. For each liquidatable account: estimate debt → Balancer flash loan → `absorb()` → `buyCollateral()` → DEX swap → repay flash loan → skim profit

### Moonwell (Compound V2) Flow

1. **Account discovery**: `MoonwellAccountRegistry` scans `Borrow` events per mToken to find accounts with debt
2. **Polling**: `watchBlocks` → batch `getAccountLiquidity()` checks → find accounts with shortfall > 0
3. For each liquidatable account: find borrow/collateral mTokens → Balancer flash loan → `liquidateBorrow()` → `redeemUnderlying()` → DEX swap → repay flash loan → skim profit

## Security Features

- **Token blacklist**: Markets involving depegged/risky tokens (e.g., USR) are skipped entirely
- **Pricer mandatory**: Bot refuses to execute trades without configured pricers (cannot verify profitability)
- **Slippage protection**: Flash loan path enforces 1% slippage margin between simulation and execution
- **Simulation-first**: All transactions simulated before execution; failed simulations are skipped
- **Treasury separation**: Profits sent to configured treasury address (not EOA) for reduced private key exposure
- **Encoder snapshot/restore**: Failed venue attempts don't corrupt encoder state

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Detailed architecture, bot flows, and configuration
- [TECHNICAL_SPEC.md](./TECHNICAL_SPEC.md) — Technical specifications and implementation details
