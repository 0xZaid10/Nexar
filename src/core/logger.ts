// src/core/logger.ts
// Structured terminal logger used across all NEXAR modules.
// Clean, colored output for both demo legibility and production debugging.

type LogLevel = "debug" | "info" | "warn" | "error" | "success";

interface LogEntry {
  level:     LogLevel;
  module:    string;
  message:   string;
  data?:     Record<string, unknown>;
  timestamp: string;
}

// ─── ANSI colors ─────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  // Text colors
  gray:    "\x1b[90m",
  white:   "\x1b[97m",
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  blue:    "\x1b[34m",
} as const;

const LEVEL_CONFIG: Record<LogLevel, { color: string; icon: string; label: string }> = {
  debug:   { color: C.gray,    icon: "·",  label: "DEBUG" },
  info:    { color: C.cyan,    icon: "◆",  label: "INFO " },
  warn:    { color: C.yellow,  icon: "▲",  label: "WARN " },
  error:   { color: C.red,     icon: "✖",  label: "ERROR" },
  success: { color: C.green,   icon: "✔",  label: "OK   " },
};

// ─── Log level filtering ──────────────────────────────────────────────────────

const LOG_LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error", "success"];

function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) >= LOG_LEVEL_ORDER.indexOf(minLevel);
}

// ─── Logger class ─────────────────────────────────────────────────────────────

export class Logger {
  private readonly module: string;
  private readonly minLevel: LogLevel;
  private readonly silent: boolean;

  constructor(module: string, options?: { minLevel?: LogLevel; silent?: boolean }) {
    this.module   = module;
    this.minLevel = options?.minLevel ?? (process.env.LOG_LEVEL as LogLevel) ?? "info";
    this.silent   = options?.silent   ?? process.env.NODE_ENV === "test";
  }

  private format(entry: LogEntry): string {
    const cfg   = LEVEL_CONFIG[entry.level];
    const ts    = `${C.dim}${entry.timestamp}${C.reset}`;
    const icon  = `${cfg.color}${C.bold}${cfg.icon}${C.reset}`;
    const label = `${cfg.color}${cfg.label}${C.reset}`;
    const mod   = `${C.magenta}[${entry.module}]${C.reset}`;
    const msg   = entry.level === "error"
      ? `${C.red}${entry.message}${C.reset}`
      : entry.level === "success"
      ? `${C.green}${entry.message}${C.reset}`
      : entry.message;

    let line = `${ts} ${icon} ${label} ${mod} ${msg}`;

    if (entry.data && Object.keys(entry.data).length > 0) {
      const dataStr = Object.entries(entry.data)
        .map(([k, v]) => `${C.dim}${k}${C.reset}=${C.cyan}${String(v)}${C.reset}`)
        .join(" ");
      line += `\n  ${C.dim}└${C.reset} ${dataStr}`;
    }

    return line;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.silent || !shouldLog(level, this.minLevel)) return;

    const entry: LogEntry = {
      level,
      module:    this.module,
      message,
      data,
      timestamp: new Date().toISOString().slice(11, 23), // HH:MM:SS.mmm
    };

    const line = this.format(entry);
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  success(message: string, data?: Record<string, unknown>): void {
    this.log("success", message, data);
  }

  // Separator line for demo output readability
  separator(label?: string): void {
    if (this.silent) return;
    const line = label
      ? `${C.dim}${"─".repeat(20)} ${C.bold}${label}${C.reset}${C.dim} ${"─".repeat(20)}${C.reset}`
      : `${C.dim}${"─".repeat(60)}${C.reset}`;
    process.stdout.write(line + "\n");
  }

  // Child logger for sub-operations
  child(subModule: string): Logger {
    return new Logger(`${this.module}:${subModule}`, {
      minLevel: this.minLevel,
      silent:   this.silent,
    });
  }
}

// ─── Module-scoped logger factory ─────────────────────────────────────────────

export function createLogger(module: string, options?: { silent?: boolean }): Logger {
  return new Logger(module, options);
}

// ─── Shared loggers for each NEXAR layer ─────────────────────────────────────

export const log = {
  sdk:       createLogger("SDK"),
  auth:      createLogger("AUTH"),
  licensing: createLogger("LICENSE"),
  runtime:   createLogger("RUNTIME"),
  agents:    createLogger("AGENTS"),
  demo:      createLogger("DEMO"),
  deploy:    createLogger("DEPLOY"),
} as const;
