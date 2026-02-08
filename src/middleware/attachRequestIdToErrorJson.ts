import type { NextFunction, Request, Response } from "express";

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Ensures JSON error responses include `{ requestId }` for correlation.
 *
 * Applies when:
 * - `res.statusCode >= 400`
 * - `res.json()` is called with a plain object containing an `error` field
 * - body does not already include `requestId`
 */
export function attachRequestIdToErrorJsonMiddleware(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = ((body: any) => {
    const requestId = (req as any).requestId ?? (req as any).id;
    if (!requestId) return originalJson(body);

    try {
      if (res.statusCode >= 400 && isPlainObject(body) && "error" in body && body.requestId == null) {
        res.setHeader("X-Request-Id", requestId);
        return originalJson({ ...body, requestId });
      }
    } catch {
      // fall through
    }

    return originalJson(body);
  }) as any;

  next();
}
