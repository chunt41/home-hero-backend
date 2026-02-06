import * as jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("Missing JWT_SECRET in environment");
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({ error: "Invalid Authorization header format" });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: number;
      role: string;
      impersonatedByAdminId?: number;
      isImpersonated?: boolean;
    };

    const isMissingDbColumnError = (err: any): boolean => {
      const msg = String(err?.message ?? "");
      return msg.includes("does not exist") && msg.includes("column");
    };

    let dbUser: any;
    try {
      dbUser = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          role: true,
          isSuspended: true,
          suspendedAt: true,
          suspendedReason: true,
          emailVerifiedAt: true,
          riskScore: true,
          restrictedUntil: true,
        },
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      dbUser = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          role: true,
          isSuspended: true,
          suspendedAt: true,
          suspendedReason: true,
          emailVerifiedAt: true,
        },
      });
    }

    if (!dbUser) return res.status(401).json({ error: "User not found for token" });

    req.user = {
      userId: dbUser.id,
      role: dbUser.role,
      isSuspended: dbUser.isSuspended,
      suspendedAt: dbUser.suspendedAt,
      suspendedReason: dbUser.suspendedReason,
      emailVerifiedAt: dbUser.emailVerifiedAt,
      riskScore: typeof dbUser.riskScore === "number" ? dbUser.riskScore : undefined,
      restrictedUntil: dbUser.restrictedUntil ?? undefined,
      impersonatedByAdminId: decoded.impersonatedByAdminId,
      isImpersonated: decoded.isImpersonated,
    };

    // Enforce suspension (admins can still use admin routes; non-admins blocked)
    if (dbUser.isSuspended && dbUser.role !== "ADMIN") {
      return res.status(403).json({
        error: "Your account has been suspended.",
        suspendedAt: dbUser.suspendedAt,
        suspendedReason: dbUser.suspendedReason,
      });
    }

    return next();
  } catch (err) {
    console.error("JWT verification error:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

