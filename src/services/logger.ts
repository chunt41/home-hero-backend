export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, message: string, fields?: LogFields) {
  const line = {
    timestamp: nowIso(),
    level,
    message,
    ...(fields ?? {}),
  };

  const json = JSON.stringify(line);

  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(json);
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(json);
  } else {
    // eslint-disable-next-line no-console
    console.log(json);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
