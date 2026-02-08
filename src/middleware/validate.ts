import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z, type ZodTypeAny } from "zod";

export type SchemaBundle = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

export type Validated<S extends SchemaBundle> = {
  body: S["body"] extends ZodTypeAny ? z.infer<S["body"]> : unknown;
  query: S["query"] extends ZodTypeAny ? z.infer<S["query"]> : unknown;
  params: S["params"] extends ZodTypeAny ? z.infer<S["params"]> : unknown;
};

export type ValidatedRequest<S extends SchemaBundle> = Request & {
  validated: Validated<S>;
};

function toDetails(err: z.ZodError) {
  return err.issues.map((i) => ({
    path: i.path,
    message: i.message,
    code: i.code,
  }));
}

/**
 * Validates req.body / req.query / req.params.
 * - On success attaches typed `req.validated = { body, query, params }`.
 * - On failure returns 400: { error: "Validation failed", details: [...] }
 */
export function validate<S extends SchemaBundle>(schemas: S): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const details: Array<{ path: (string | number)[]; message: string; code: string }> = [];

    const requestId = (req as any).requestId ?? (req as any).id;

    const validated: any = {
      body: req.body,
      query: req.query,
      params: req.params,
    };

    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (!parsed.success) details.push(...toDetails(parsed.error));
      else validated.body = parsed.data;
    }

    if (schemas.query) {
      const parsed = schemas.query.safeParse(req.query);
      if (!parsed.success) details.push(...toDetails(parsed.error));
      else validated.query = parsed.data;
    }

    if (schemas.params) {
      const parsed = schemas.params.safeParse(req.params);
      if (!parsed.success) details.push(...toDetails(parsed.error));
      else validated.params = parsed.data;
    }

    if (details.length) {
      return res.status(400).json({ error: "Validation failed", requestId, details });
    }

    (req as any).validated = validated;
    return next();
  };
}
