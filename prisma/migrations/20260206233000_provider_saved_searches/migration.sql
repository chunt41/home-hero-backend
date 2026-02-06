-- Provider saved searches

CREATE TABLE IF NOT EXISTS "ProviderSavedSearch" (
  "id" SERIAL PRIMARY KEY,
  "providerId" INTEGER NOT NULL,
  "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "radiusMiles" INTEGER NOT NULL,
  "zipCode" TEXT NOT NULL,
  "minBudget" INTEGER,
  "maxBudget" INTEGER,
  "isEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderSavedSearch_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProviderSavedSearch_providerId_idx" ON "ProviderSavedSearch"("providerId");
CREATE INDEX IF NOT EXISTS "ProviderSavedSearch_providerId_isEnabled_idx" ON "ProviderSavedSearch"("providerId", "isEnabled");
CREATE INDEX IF NOT EXISTS "ProviderSavedSearch_createdAt_idx" ON "ProviderSavedSearch"("createdAt");
