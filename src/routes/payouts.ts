import express from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { createAsyncRouter } from "../middleware/asyncWrap";

const router = createAsyncRouter(express);

const requestPayoutSchema = {
  body: z.object({
    amount: z.coerce.number().positive("amount must be a positive number"),
    type: z.enum(["subscription", "ad_revenue"]),
  }),
};

/**
 * GET /payouts/me
 * Get current user's payout history
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user!.userId;

    const payouts = await prisma.payout.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json(payouts);
  } catch (error: any) {
    console.error("Error fetching payouts:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /payouts/summary/me
 * Get payout summary for current user
 */
router.get("/summary/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user!.userId;

    const payouts = await prisma.payout.findMany({
      where: { userId },
    });

    const totalPaid = payouts
      .filter((p) => p.status === "completed")
      .reduce((sum, p) => sum + Number(p.amount), 0);

    const pendingAmount = payouts
      .filter((p) => p.status === "pending" || p.status === "processing")
      .reduce((sum, p) => sum + Number(p.amount), 0);

    const failedAmount = payouts
      .filter((p) => p.status === "failed")
      .reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({
      totalPaid,
      pendingAmount,
      failedAmount,
      lastPayout: payouts.find((p) => p.status === "completed")?.paidAt,
      payoutCount: payouts.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /payouts/request
 * Request a payout (admin will review and process)
 */
router.post("/request", authMiddleware, validate(requestPayoutSchema), async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { amount, type } = (req as any).validated.body as { amount: number; type: "subscription" | "ad_revenue" };

    // Check if user has pending payouts
    const pending = await prisma.payout.findFirst({
      where: {
        userId,
        status: "pending",
      },
    });

    if (pending) {
      return res.status(400).json({
        error: "You already have a pending payout request",
      });
    }

    const payout = await prisma.payout.create({
      data: {
        userId,
        type,
        amount: String(amount),
        currency: "usd",
        status: "pending",
        description: `${type === "subscription" ? "Subscription" : "Ad Revenue"} payout request`,
      },
    });

    res.json({
      success: true,
      payout,
    });
  } catch (error: any) {
    console.error("Payout request error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /payouts/:userId (admin only)
 * Get payouts for a specific user
 */
router.get("/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestUserId = req.user!.userId;

    // Only admins or the user themselves can view
    if (parseInt(userId) !== requestUserId && req.user!.role !== "ADMIN") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const payouts = await prisma.payout.findMany({
      where: { userId: parseInt(userId) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json(payouts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
