import type { Request, Response, NextFunction } from "express";

export function requireVerifiedEmail(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });

  // Admins can proceed (useful for support/impersonation flows)
  if (req.user.role === "ADMIN") return next();

  // Allow admin impersonation sessions to proceed.
  if ((req.user as any).isImpersonated) return next();

  if (!req.user.emailVerifiedAt) {
    return res.status(403).json({
      error: "Email address not verified",
      code: "EMAIL_NOT_VERIFIED",
    });
  }

  return next();
}
