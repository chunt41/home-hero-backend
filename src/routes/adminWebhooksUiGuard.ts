import * as crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function isAdminUiEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.ADMIN_UI_ENABLED ?? "").toLowerCase() === "true";
}

export function createRequireAdminUiEnabled(env: NodeJS.ProcessEnv) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!isAdminUiEnabled(env)) {
      return res.status(404).send("Not found");
    }
    return next();
  };
}

export function createBasicAuthForAdminUi(env: NodeJS.ProcessEnv) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (env.NODE_ENV !== "production") return next();

    const user = String(env.ADMIN_UI_BASIC_USER ?? "");
    const pass = String(env.ADMIN_UI_BASIC_PASS ?? "");

    // Fail closed in prod if creds are missing.
    if (!user || !pass) {
      return res.status(404).send("Not found");
    }

    const header = String(req.headers.authorization ?? "");
    if (!header.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin UI"');
      return res.status(401).send("Authentication required");
    }

    let decoded = "";
    try {
      decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    } catch {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin UI"');
      return res.status(401).send("Authentication required");
    }

    const idx = decoded.indexOf(":");
    const u = idx >= 0 ? decoded.slice(0, idx) : "";
    const p = idx >= 0 ? decoded.slice(idx + 1) : "";

    // timing-safe-ish compare (avoid short-circuit obvious mismatches)
    const ok =
      u.length === user.length &&
      p.length === pass.length &&
      crypto.timingSafeEqual(Buffer.from(u), Buffer.from(user)) &&
      crypto.timingSafeEqual(Buffer.from(p), Buffer.from(pass));

    if (!ok) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Admin UI"');
      return res.status(401).send("Authentication required");
    }

    return next();
  };
}
