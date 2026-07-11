/**
 * Debug logger for liquidation decisions.
 * Provides detailed output to verify liquidation logic is correct.
 */

import { coloredConsole } from "./coloredLogger.js";

export interface LiquidationDebugInfo {
  protocol: string;
  account: string;
  healthFactor?: number;
  collateral?: {
    token: string;
    amount: bigint;
    usdValue?: number;
  };
  debt?: {
    token: string;
    amount: bigint;
    usdValue?: number;
  };
  seizableCollateral?: bigint;
  isBadDebt?: boolean;
  decision: "liquidate" | "skip";
  reason: string;
  details?: Record<string, unknown>;
}

export function logLiquidationDebug(info: LiquidationDebugInfo): void {
  const prefix = `[${info.protocol} Liquidation Debug]`;

  coloredConsole.log(`\n${"═".repeat(80)}`);
  coloredConsole.log(`${prefix} ${info.decision === "liquidate" ? "🎯 LIQUIDATE" : "⏭️ SKIP"}`);
  coloredConsole.log(`${"═".repeat(80)}`);

  coloredConsole.log(`Account: ${info.account}`);

  if (info.healthFactor !== undefined) {
    const hfColor = info.healthFactor < 1 ? "🔴" : info.healthFactor < 1.1 ? "🟡" : "🟢";
    coloredConsole.log(`Health Factor: ${hfColor} ${info.healthFactor.toFixed(6)}`);
  }

  if (info.collateral) {
    coloredConsole.log(`\nCollateral:`);
    coloredConsole.log(`  Token: ${info.collateral.token}`);
    coloredConsole.log(`  Amount: ${info.collateral.amount.toString()}`);
    if (info.collateral.usdValue !== undefined) {
      coloredConsole.log(`  USD Value: $${info.collateral.usdValue.toFixed(2)}`);
    }
  }

  if (info.debt) {
    coloredConsole.log(`\nDebt:`);
    coloredConsole.log(`  Token: ${info.debt.token}`);
    coloredConsole.log(`  Amount: ${info.debt.amount.toString()}`);
    if (info.debt.usdValue !== undefined) {
      coloredConsole.log(`  USD Value: $${info.debt.usdValue.toFixed(2)}`);
    }
  }

  if (info.seizableCollateral !== undefined) {
    coloredConsole.log(`\nSeizable Collateral: ${info.seizableCollateral.toString()}`);
  }

  if (info.isBadDebt !== undefined) {
    coloredConsole.log(`Bad Debt: ${info.isBadDebt ? "⚠️ YES (underwater)" : "NO"}`);
  }

  coloredConsole.log(`\nDecision: ${info.decision.toUpperCase()}`);
  coloredConsole.log(`Reason: ${info.reason}`);

  if (info.details && Object.keys(info.details).length > 0) {
    coloredConsole.log(`\nDetails:`);
    for (const [key, value] of Object.entries(info.details)) {
      coloredConsole.log(`  ${key}: ${value}`);
    }
  }

  coloredConsole.log(`${"═".repeat(80)}\n`);
}
