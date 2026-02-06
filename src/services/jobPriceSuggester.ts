export type JobPriceSuggestion = {
  suggestedMinPrice: number | null;
  suggestedMaxPrice: number | null;
  suggestedReason: string | null;
};

type JobPriceSuggesterInput = {
  category?: string | null;
  trade?: string | null;
  location?: string | null;
  title?: string | null;
  description?: string | null;
};

function normalize(s: string | null | undefined) {
  return (s ?? "").toLowerCase();
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function roundToNice(n: number) {
  if (n <= 0) return 0;
  if (n < 100) return Math.round(n / 10) * 10;
  if (n < 1000) return Math.round(n / 25) * 25;
  return Math.round(n / 50) * 50;
}

function detectJobSizeFactor(text: string): { factor: number; label: string } {
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  // Keyword bumps for larger jobs.
  const hasBigSignals =
    /\b(entire|whole|full|complete|multiple|several|all rooms|move[- ]out|deep clean|rewire|panel upgrade|replace all|new install)\b/i.test(
      text
    );

  const hasSmallSignals =
    /\b(quick|small|minor|simple|patch|touch[- ]up|one (room|sink|outlet|light|toilet))\b/i.test(
      text
    );

  let factor = 1.0;
  let label = "medium";

  if (words < 20) {
    factor = 0.85;
    label = "small";
  } else if (words < 60) {
    factor = 1.0;
    label = "medium";
  } else if (words < 120) {
    factor = 1.2;
    label = "large";
  } else {
    factor = 1.4;
    label = "very large";
  }

  if (hasBigSignals) {
    factor *= 1.15;
    label = label === "small" ? "medium" : label;
  }

  if (hasSmallSignals) {
    factor *= 0.9;
  }

  return { factor, label };
}

function detectLocationFactor(location: string): { factor: number; label: string } {
  const loc = normalize(location);

  // Very rough cost-of-living heuristics.
  if (/(san francisco|sf\b|bay area|san jose|palo alto|menlo park|oakland)/i.test(loc)) {
    return { factor: 1.45, label: "high-cost area" };
  }
  if (/(new york|nyc|manhattan|brooklyn|queens|jersey city|hoboken)/i.test(loc)) {
    return { factor: 1.4, label: "high-cost area" };
  }
  if (/(seattle|boston|los angeles|la\b|san diego|washington dc|dc\b)/i.test(loc)) {
    return { factor: 1.25, label: "higher-cost area" };
  }
  if (/(austin|denver|portland|phoenix|miami|chicago)/i.test(loc)) {
    return { factor: 1.15, label: "moderate-cost area" };
  }
  if (/(rural|small town|country)/i.test(loc)) {
    return { factor: 0.9, label: "lower-cost area" };
  }

  return { factor: 1.0, label: "typical area" };
}

function baseRangeForCategory(category: string, trade?: string | null): { min: number; max: number; label: string } {
  const c = normalize(category);
  const t = normalize(trade);

  // Baselines assume a typical, medium-size job.
  if (c.includes("plumb") || t.includes("plumb")) return { min: 150, max: 450, label: "plumbing" };
  if (c.includes("electric") || t.includes("electric")) return { min: 180, max: 550, label: "electrical" };
  if (c.includes("hvac") || t.includes("hvac")) return { min: 250, max: 900, label: "HVAC" };
  if (c.includes("roof")) return { min: 300, max: 1200, label: "roofing" };
  if (c.includes("paint")) return { min: 200, max: 800, label: "painting" };
  if (c.includes("landsc") || c.includes("lawn")) return { min: 120, max: 500, label: "landscaping" };
  if (c.includes("clean")) return { min: 120, max: 350, label: "cleaning" };
  if (c.includes("pest")) return { min: 120, max: 400, label: "pest control" };
  if (c.includes("move")) return { min: 250, max: 900, label: "moving" };
  if (c.includes("appliance")) return { min: 120, max: 450, label: "appliance repair" };

  return { min: 150, max: 500, label: "general" };
}

export function suggestJobPrice(input: JobPriceSuggesterInput): JobPriceSuggestion {
  const title = input.title ?? "";
  const description = input.description ?? "";
  const location = input.location ?? "";

  const text = `${title}\n${description}`.trim();
  const category = input.category ?? "";

  if (!text) {
    return {
      suggestedMinPrice: null,
      suggestedMaxPrice: null,
      suggestedReason: null,
    };
  }

  const base = baseRangeForCategory(category, input.trade);
  const size = detectJobSizeFactor(text);
  const loc = detectLocationFactor(location);

  const min = roundToNice(base.min * size.factor * loc.factor);
  const max = roundToNice(base.max * size.factor * loc.factor);

  // Ensure min <= max and keep within sane bounds.
  const suggestedMinPrice = clampInt(Math.min(min, max), 25, 20000);
  const suggestedMaxPrice = clampInt(Math.max(min, max), suggestedMinPrice, 25000);

  const suggestedReason = `Based on ${base.label}${location ? ` in a ${loc.label}` : ""} and a ${size.label} job description.`;

  return {
    suggestedMinPrice,
    suggestedMaxPrice,
    suggestedReason,
  };
}
