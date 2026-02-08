import { AsyncLocalStorage } from "node:async_hooks";

export type LogContext = {
  requestId?: string;
  method?: string;
  path?: string;
  userId?: number;

  // Worker / background fields (optional)
  jobId?: number;
  jobType?: string;
  webhookDeliveryId?: number;
  webhookAttemptId?: number;
};

const storage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...context }, fn);
}
