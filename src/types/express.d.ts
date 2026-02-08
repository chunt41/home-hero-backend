// src/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface Request {
      id?: string;
      requestId?: string;
      requestStart?: bigint;
      user?: {
        userId: number;
        role: "CONSUMER" | "PROVIDER" | "ADMIN";
        isSuspended: boolean;
        suspendedAt?: Date | null;
        suspendedReason?: string | null;
        emailVerifiedAt?: Date | null;
        riskScore?: number;
        restrictedUntil?: Date | null;
        impersonatedByAdminId?: number;
        isImpersonated?: boolean;
      };
      rawBody?: string;
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
