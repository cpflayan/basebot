/**
 * Colored console logger with timestamps for bot output.
 * Also appends plain (no ANSI) lines to a log file with size-based rotation.
 *
 * Env:
 *   LOG_FILE=logs/bot.log       — path relative to cwd or absolute (default logs/bot.log)
 *   LOG_TO_FILE=0               — disable file logging
 *   LOG_FILE_MAX_MB=20          — rotate when active file exceeds this size (default 20)
 *   LOG_FILE_MAX_FILES=5        — keep bot.log + bot.log.1 … bot.log.(N-1) (default 5 total)
 */
import fs from "node:fs";
import path from "node:path";

// Save original console methods before any overrides
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",

  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  // Bright foreground colors
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
};

// Protocol color mapping
const protocolColors: Record<string, string> = {
  "[Base client]": colors.brightRed,
  "[Base comet]": colors.brightYellow,
  "[Base moonwell]": colors.brightGreen,
  "[Base aave]": colors.brightCyan,
  "[Webhook]": colors.brightMagenta,
  "[CometRegistry]": colors.yellow,
  "[MoonwellRegistry]": colors.green,
  "[AaveRegistry]": colors.cyan,
};

// eslint-disable-next-line no-control-regex -- strip ANSI color codes for file logs
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function getTimestampPlain(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().slice(0, 8); // HH:MM:SS for file logs
  return `[${date}][${time}]`;
}

function getTimestampColored(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().slice(0, 5);
  return `${colors.white}[${date}][${time}]${colors.reset}`;
}

function colorizeProtocol(message: string): string {
  for (const [protocol, color] of Object.entries(protocolColors)) {
    if (message.includes(protocol)) {
      return message.replace(protocol, `${color}${protocol}${colors.reset}`);
    }
  }
  return message;
}

// ─── File sink (appendFileSync + size rotation; no async stream lag) ───

let logFilePath: string | null = null;
let fileLogDisabled = false;
let fileReady = false;
/** Bytes in the current active segment. */
let currentFileBytes = 0;
let rotateInProgress = false;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function maxFileBytes(): number {
  return envPositiveInt("LOG_FILE_MAX_MB", 20) * 1024 * 1024;
}

/** Total segments kept including the active `bot.log` (e.g. 5 → bot.log + .1 … .4). */
function maxFiles(): number {
  return Math.max(1, envPositiveInt("LOG_FILE_MAX_FILES", 5));
}

function resolveLogFilePath(): string | null {
  if (process.env.LOG_TO_FILE === "0" || process.env.LOG_TO_FILE === "false") {
    return null;
  }
  const raw = process.env.LOG_FILE?.trim() || "logs/bot.log";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/**
 * Rotate: bot.log.(N-2) → bot.log.(N-1), …, bot.log → bot.log.1.
 * Oldest segment beyond maxFiles is deleted.
 */
function rotateLogFiles(filePath: string): void {
  const keep = maxFiles();
  const archiveSlots = keep - 1;

  if (archiveSlots >= 1) {
    const oldest = `${filePath}.${archiveSlots}`;
    try {
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    } catch {
      // ignore
    }
  }

  for (let i = archiveSlots - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // ignore
    }
  }

  if (archiveSlots >= 1) {
    try {
      if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      // ignore
    }
  } else {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

function ensureFileReady(): boolean {
  if (fileLogDisabled) return false;
  if (fileReady && logFilePath) return true;

  const filePath = resolveLogFilePath();
  if (!filePath) {
    fileLogDisabled = true;
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let existing = 0;
    try {
      existing = fs.statSync(filePath).size;
    } catch {
      existing = 0;
    }
    logFilePath = filePath;
    currentFileBytes = existing;
    fileReady = true;

    const maxMb = envPositiveInt("LOG_FILE_MAX_MB", 20);
    const keep = maxFiles();
    const banner =
      `${getTimestampPlain()} [Logger] File logging → ${filePath}` +
      ` (rotate @ ${maxMb}MB, keep ${keep} files)\n`;
    fs.appendFileSync(filePath, banner, "utf8");
    currentFileBytes += Buffer.byteLength(banner, "utf8");
    originalConsole.log(
      `${getTimestampColored()} ${colors.dim}[Logger] File logging → ${filePath}` +
        ` (rotate @ ${maxMb}MB × ${keep})${colors.reset}`,
    );
    return true;
  } catch (err) {
    originalConsole.error(
      `[Logger] Cannot open log file ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
    fileLogDisabled = true;
    return false;
  }
}

function maybeRotateBeforeWrite(lineBytes: number): void {
  if (rotateInProgress || !logFilePath) return;
  const limit = maxFileBytes();
  if (currentFileBytes + lineBytes < limit) return;

  rotateInProgress = true;
  try {
    rotateLogFiles(logFilePath);
    currentFileBytes = 0;
    const note = `${getTimestampPlain()} [Logger] Rotated log (max ${envPositiveInt("LOG_FILE_MAX_MB", 20)}MB)\n`;
    fs.appendFileSync(logFilePath, note, "utf8");
    currentFileBytes = Buffer.byteLength(note, "utf8");
    originalConsole.log(
      `${getTimestampColored()} ${colors.dim}[Logger] Rotated log file → ${logFilePath}${colors.reset}`,
    );
  } catch (err) {
    originalConsole.error(
      `[Logger] Log rotate failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    rotateInProgress = false;
  }
}

function writeToFile(level: string, message: string): void {
  if (!ensureFileReady() || !logFilePath) return;
  const line = `${getTimestampPlain()} [${level}] ${stripAnsi(message)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  maybeRotateBeforeWrite(lineBytes);
  try {
    fs.appendFileSync(logFilePath, line, "utf8");
    currentFileBytes += lineBytes;
  } catch (err) {
    originalConsole.error(
      `[Logger] Failed writing log file: ${err instanceof Error ? err.message : err}`,
    );
    fileLogDisabled = true;
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const coloredConsole = {
  log(...args: unknown[]): void {
    const message = formatArgs(args);
    const timestamp = getTimestampColored();
    const coloredMessage = colorizeProtocol(message);
    originalConsole.log(`${timestamp} ${coloredMessage}`);
    writeToFile("INFO", message);
  },

  error(...args: unknown[]): void {
    const message = formatArgs(args);
    const timestamp = getTimestampColored();
    const coloredMessage = colorizeProtocol(message);
    originalConsole.error(`${timestamp} ${colors.brightRed}${coloredMessage}${colors.reset}`);
    writeToFile("ERROR", message);
  },

  warn(...args: unknown[]): void {
    const message = formatArgs(args);
    const timestamp = getTimestampColored();
    const coloredMessage = colorizeProtocol(message);
    originalConsole.warn(`${timestamp} ${colors.brightYellow}${coloredMessage}${colors.reset}`);
    writeToFile("WARN", message);
  },
};

/** Absolute path currently used, or null if file logging is off/failed. */
export function getLogFilePath(): string | null {
  return logFilePath ?? resolveLogFilePath();
}
