import type { Request, Response } from "express";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

export function createGetProviderEntitlementsHandler(deps: {
  prisma: {
    providerEntitlement: {
      findUnique: (args: any) => Promise<any>;
    };
  };
}) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can view entitlements." });
      }

      // Read-only: do not create or mutate entitlements rows here.
      // Entitlements are granted via Stripe webhooks when payments succeed.
      const ent = await prisma.providerEntitlement.findUnique({
        where: { providerId: req.user.userId },
      });

      return res.json({
        entitlements: ent ?? {
          providerId: req.user.userId,
          verificationBadge: false,
          featuredZipCodes: [],
          leadCredits: 0,
        },
      });
    } catch (err) {
      console.error("GET /provider/entitlements error:", err);
      return res.status(500).json({ error: "Internal server error while fetching entitlements." });
    }
  };
}
