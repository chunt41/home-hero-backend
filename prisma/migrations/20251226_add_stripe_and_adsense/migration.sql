-- Add Stripe payment integration
CREATE TABLE "StripePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "subscriptionId" INTEGER,
    "tier" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripePaymentIntentId" TEXT NOT NULL UNIQUE,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StripePayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StripePayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Add AdMob revenue tracking
CREATE TABLE "AdRevenue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "adFormat" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'admob',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(10,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdRevenue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Add payout tracking
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripePayoutId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    CONSTRAINT "Payout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Add indexes for performance
CREATE INDEX "StripePayment_userId_idx" ON "StripePayment"("userId");
CREATE INDEX "StripePayment_status_idx" ON "StripePayment"("status");
CREATE INDEX "StripePayment_createdAt_idx" ON "StripePayment"("createdAt");
CREATE INDEX "AdRevenue_userId_idx" ON "AdRevenue"("userId");
CREATE INDEX "AdRevenue_date_idx" ON "AdRevenue"("date");
CREATE INDEX "Payout_userId_idx" ON "Payout"("userId");
CREATE INDEX "Payout_status_idx" ON "Payout"("status");
