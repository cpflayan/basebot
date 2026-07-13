/**
 * Colored console logger with timestamps for bot output.
 * Also appends plain (no ANSI) lines to a fixed log file (default: logs/bot.log).
 *
 * Env:
 *   LOG_FILE=logs/bot.log   — path relative to cwd or absolute (default logs/bot.log)
 *   LOG_TO_FILE=0           — disable file logging
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

// ─── File sink (append, plain text) ───

let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let fileLogDisabled = false;

function resolveLogFilePath(): string | null {
  if (process.env.LOG_TO_FILE === "0" || process.env.LOG_TO_FILE === "false") {
    return null;
  }
  const raw = process.env.LOG_FILE?.trim() || "logs/bot.log";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function ensureLogStream(): fs.WriteStream | null {
  if (fileLogDisabled) return null;
  if (logStream) return logStream;

  const filePath = resolveLogFilePath();
  if (!filePath) {
    fileLogDisabled = true;
    return null;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    logStream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
    logFilePath = filePath;
    logStream.on("error", (err) => {
      originalConsole.error(`[Logger] Failed writing log file: ${err.message}`);
      try {
        logStream?.destroy();
      } catch {
        // ignore
      }
      logStream = null;
      fileLogDisabled = true;
    });
    // One-time banner so operators know where file logs go
    const banner = `${getTimestampPlain()} [Logger] File logging → ${filePath}\n`;
    logStream.write(banner);
    originalConsole.log(
      `${getTimestampColored()} ${colors.dim}[Logger] File logging → ${filePath}${colors.reset}`,
    );
    return logStream;
  } catch (err) {
    originalConsole.error(
      `[Logger] Cannot open log file ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
    fileLogDisabled = true;
    return null;
  }
}

function writeToFile(level: string, message: string): void {
  const stream = ensureLogStream();
  if (!stream) return;
  const line = `${getTimestampPlain()} [${level}] ${stripAnsi(message)}\n`;
  stream.write(line);
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
