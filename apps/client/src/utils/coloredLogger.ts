/**
 * Colored console logger with timestamps for bot output.
 * Adds visual distinction between different protocols and time tracking.
 */

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

function getTimestamp(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0].substring(0, 5);
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

export const coloredConsole = {
  log(...args: unknown[]): void {
    const message = args.join(" ");
    const timestamp = getTimestamp();
    const coloredMessage = colorizeProtocol(message);
    originalConsole.log(`${timestamp} ${coloredMessage}`);
  },

  error(...args: unknown[]): void {
    const message = args.join(" ");
    const timestamp = getTimestamp();
    const coloredMessage = colorizeProtocol(message);
    originalConsole.error(`${timestamp} ${colors.brightRed}${coloredMessage}${colors.reset}`);
  },

  warn(...args: unknown[]): void {
    const message = args.join(" ");
    const timestamp = getTimestamp();
    const coloredMessage = colorizeProtocol(message);
    originalConsole.warn(`${timestamp} ${colors.brightYellow}${coloredMessage}${colors.reset}`);
  },
};
