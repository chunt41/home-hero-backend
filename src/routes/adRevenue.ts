import express from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import {
  recordAdRevenue,
  getUserAdRevenue,
  stripe,
} from "../services/stripeService";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { createAsyncRouter } from "../middleware/asyncWrap";
import { logger } from "../services/logger";

const router = createAsyncRouter(express);

const recordAdRevenueSchema = {
  body: z.object({
    adFormat: z.enum(["banner", "interstitial"]),
    revenue: z.coerce.number().min(0, "revenue must be >= 0"),
  }),
};

const admobWebhookSchema = {
  body: z.object({
    userId: z.coerce.number().int().positive(),
    adFormat: z.enum(["banner", "interstitial"]),
    revenue: z.coerce.number(),
    date: z.string().optional(),
  }),
};

/**
 * POST /ad-revenue/record
 * Record ad impression or click (called from mobile app)
 */
router.post("/record", authMiddleware, validate(recordAdRevenueSchema), async (req, res) => {
  try {
    const { adFormat, revenue } = (req as any).validated.body as { adFormat: "banner" | "interstitial"; revenue: number };
    const userId = req.user!.userId;

    const result = await recordAdRevenue(userId, adFormat, revenue);

    res.json({
      success: true,
      adRevenue: result,
    });
  } catch (error: any) {
    logger.error("adRevenue.record_error", { message: String(error?.message ?? error) });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /ad-revenue/summary/:userId
 * Get ad revenue summary for a user
 */
router.get("/summary/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { days = "30" } = req.query;
    const requestUserId = req.user!.userId;

    // Users can only view their own revenue unless they're admin
    if (parseInt(userId) !== requestUserId && req.user!.role !== "ADMIN") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const numDays = parseInt(days as string) || 30;
    const summary = await getUserAdRevenue(parseInt(userId), numDays);

    // Get breakdown by format
    const startDate = new Date(Date.now() - numDays * 24 * 60 * 60 * 1000);
    const byFormat = await prisma.adRevenue.groupBy({
      by: ["adFormat"],
      where: {
        userId: parseInt(userId),
        date: { gte: startDate },
      },
      _sum: { revenue: true, impressions: true, clicks: true },
    });

    res.json({
      summary,
      byFormat,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /ad-revenue/history/:userId
 * Get detailed ad revenue history
 */
router.get("/history/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = "50", offset = "0" } = req.query;
    const requestUserId = req.user!.userId;

    // Users can only view their own history unless they're admin
    if (parseInt(userId) !== requestUserId && req.user!.role !== "ADMIN") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const numLimit = parseInt(limit as string) || 50;
    const numOffset = parseInt(offset as string) || 0;

    const history = await prisma.adRevenue.findMany({
      where: { userId: parseInt(userId) },
      orderBy: { date: "desc" },
      take: numLimit,
      skip: numOffset,
    });

    const total = await prisma.adRevenue.count({
      where: { userId: parseInt(userId) },
    });

    res.json({
      history,
      total,
      limit: numLimit,
      offset: numOffset,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /ad-revenue/webhook/admob
 * Handle AdMob webhook events
 * (Google sends revenue data via webhooks)
 */
router.post("/webhook/admob", validate(admobWebhookSchema), async (req, res) => {
  try {
    const { userId, adFormat, revenue } = (req as any).validated.body as {
      userId: number;
      adFormat: "banner" | "interstitial";
      revenue: number;
    };

    await recordAdRevenue(userId, adFormat, revenue);

    res.json({ success: true });
  } catch (error: any) {
    logger.error("adRevenue.admob_webhook_error", { message: String(error?.message ?? error) });
    res.status(500).json({ error: error.message });
  }
});

export default router;
