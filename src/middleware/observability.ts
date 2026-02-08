import type { NextFunction, Request, Response } from "express";
import { logger } from "../services/logger";

export { requestIdMiddleware } from "./requestId";

function routeTemplate(req: Request): string {
  const base = String((req as any).baseUrl ?? "");
  const routePath = (req as any).route?.path;

  if (typeof routePath === "string") return `${base}${routePath}`;

  // Fallback: strip querystring
  const originalUrl = String((req as any).originalUrl ?? req.url ?? "");
  return originalUrl.split("?")[0] || "/";
}

export function httpAccessLogMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on("finish", () => {
    const start = req.requestStart;
    const durationMs = typeof start === "bigint" ? Number(process.hrtime.bigint() - start) / 1e6 : undefined;

    logger.info("http.request", {
      requestId: req.requestId ?? req.id,
      reqId: req.requestId ?? req.id,
      route: routeTemplate(req),
      method: req.method,
      status: res.statusCode,
      durationMs: typeof durationMs === "number" ? Math.round(durationMs * 100) / 100 : undefined,
      userId: req.user?.userId,
    });
  });

  next();
}
