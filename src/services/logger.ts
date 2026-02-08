import { getLogContext } from "./logContext";

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, message: string, fields?: LogFields) {
  const ctx = getLogContext();

  const ctxFields: LogFields = {
    ...(ctx?.requestId ? { requestId: ctx.requestId, reqId: ctx.requestId } : {}),
    ...(ctx?.method ? { method: ctx.method } : {}),
    ...(ctx?.path ? { path: ctx.path } : {}),
    ...(typeof ctx?.userId === "number" ? { userId: ctx.userId } : {}),
    ...(typeof ctx?.jobId === "number" ? { jobId: ctx.jobId } : {}),
    ...(typeof ctx?.jobType === "string" ? { jobType: ctx.jobType } : {}),
    ...(typeof ctx?.webhookDeliveryId === "number" ? { webhookDeliveryId: ctx.webhookDeliveryId } : {}),
    ...(typeof ctx?.webhookAttemptId === "number" ? { webhookAttemptId: ctx.webhookAttemptId } : {}),
  };

  const line = {
    timestamp: nowIso(),
    level,
    message,
    ...ctxFields,
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
