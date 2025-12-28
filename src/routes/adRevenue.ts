import express from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import {
  recordAdRevenue,
  getUserAdRevenue,
  stripe,
} from "../services/stripeService";

const router = express.Router();

/**
 * POST /ad-revenue/record
 * Record ad impression or click (called from mobile app)
 */
router.post("/record", authMiddleware, async (req, res) => {
  try {
    const { adFormat, revenue } = req.body;
    const userId = req.user!.userId;

    if (!adFormat || !["banner", "interstitial"].includes(adFormat)) {
      return res.status(400).json({ error: "Invalid ad format" });
    }

    if (typeof revenue !== "number" || revenue < 0) {
      return res.status(400).json({ error: "Invalid revenue amount" });
    }

    const result = await recordAdRevenue(userId, adFormat, revenue);

    res.json({
      success: true,
      adRevenue: result,
    });
  } catch (error: any) {
    console.error("Ad revenue recording error:", error);
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
router.post("/webhook/admob", async (req, res) => {
  try {
    const { userId, adFormat, revenue, date } = req.body;

    if (!userId || !adFormat || typeof revenue !== "number") {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await recordAdRevenue(userId, adFormat, revenue);

    res.json({ success: true });
  } catch (error: any) {
    console.error("AdMob webhook error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
