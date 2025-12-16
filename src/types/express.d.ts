// src/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        role: "CONSUMER" | "PROVIDER" | "ADMIN";
        isSuspended: boolean;
        suspendedAt?: Date | null;
        suspendedReason?: string | null;
        impersonatedByAdminId?: number;
        isImpersonated?: boolean;
      };
      rawBody?: string;
    }
  }
}

export {};
