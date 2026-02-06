export type JobUrgency = "URGENT" | "SOON" | "NORMAL";

export type JobClassification = {
  category: string;
  trade: string;
  urgency: JobUrgency;
  suggestedTags: string[];
};

export type JobClassifier = {
  classify(text: string): Promise<JobClassification>;
};

function norm(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((p) => text.includes(p));
}

function uniqSorted(tags: string[]): string[] {
  return Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function classifyUrgency(text: string): JobUrgency {
  const urgentSignals = [
    "urgent",
    "asap",
    "today",
    "right now",
    "immediately",
    "emergency",
    "flood",
    "burst",
    "sparking",
    "smoke",
    "no heat",
    "no power",
    "gas smell",
    "leaking",
    "leak",
  ];

  if (hasAny(text, urgentSignals)) return "URGENT";

  const soonSignals = ["this week", "next week", "soon", "tomorrow", "within", "schedule", "appointment"];
  if (hasAny(text, soonSignals)) return "SOON";

  return "NORMAL";
}

function classifyTradeAndCategory(text: string): { trade: string; category: string; tags: string[] } {
  const tags: string[] = [];

  const add = (t: string) => tags.push(t);

  const rules: Array<{
    trade: string;
    category: string;
    keywords: string[];
    tagHints?: string[];
  }> = [
    {
      trade: "Plumbing",
      category: "Repair",
      keywords: ["plumb", "toilet", "sink", "faucet", "pipe", "drain", "sewer", "water heater", "leak", "clog"],
      tagHints: ["plumbing"],
    },
    {
      trade: "Electrical",
      category: "Repair",
      keywords: ["electrical", "outlet", "breaker", "panel", "wiring", "light", "ceiling fan", "switch", "power"],
      tagHints: ["electrical"],
    },
    {
      trade: "HVAC",
      category: "Repair",
      keywords: ["hvac", "ac", "a c", "air conditioner", "furnace", "heat pump", "thermostat", "no heat", "no air"],
      tagHints: ["hvac"],
    },
    {
      trade: "Cleaning",
      category: "Cleaning",
      keywords: ["clean", "cleaning", "deep clean", "move out", "move-out", "maid", "carpet"],
      tagHints: ["cleaning"],
    },
    {
      trade: "Landscaping",
      category: "Outdoor",
      keywords: ["lawn", "mow", "yard", "landscap", "tree", "mulch", "hedge", "sprinkler"],
      tagHints: ["landscaping"],
    },
    {
      trade: "Painting",
      category: "Maintenance",
      keywords: ["paint", "repaint", "interior", "exterior", "primer"],
      tagHints: ["painting"],
    },
    {
      trade: "Roofing",
      category: "Repair",
      keywords: ["roof", "shingle", "gutter", "leak in roof"],
      tagHints: ["roofing"],
    },
    {
      trade: "Appliance Repair",
      category: "Repair",
      keywords: ["dishwasher", "fridge", "refrigerator", "washer", "dryer", "oven", "stove", "microwave"],
      tagHints: ["appliance"],
    },
    {
      trade: "Pest Control",
      category: "Pest Control",
      keywords: ["pest", "termite", "roach", "bed bug", "mice", "rats", "ant"],
      tagHints: ["pest"],
    },
    {
      trade: "Moving",
      category: "Moving",
      keywords: ["move", "moving", "搬"],
      tagHints: ["moving"],
    },
  ];

  for (const r of rules) {
    if (r.keywords.some((k) => text.includes(k))) {
      for (const th of r.tagHints ?? []) add(th);
      return { trade: r.trade, category: r.category, tags };
    }
  }

  return { trade: "Handyman", category: "General", tags };
}

function deriveSuggestedTags(text: string, baseTags: string[]): string[] {
  const t = text;
  const tags: string[] = [...baseTags];

  const add = (s: string, when: boolean) => {
    if (when) tags.push(s);
  };

  add("leak", t.includes("leak"));
  add("clog", t.includes("clog") || t.includes("clogged"));
  add("outlet", t.includes("outlet"));
  add("breaker", t.includes("breaker") || t.includes("panel"));
  add("thermostat", t.includes("thermostat"));
  add("lawn", t.includes("lawn") || t.includes("mow"));
  add("paint", t.includes("paint"));
  add("gutter", t.includes("gutter"));

  // Cap to keep payloads small and deterministic
  return uniqSorted(tags).slice(0, 10);
}

export const heuristicJobClassifier: JobClassifier = {
  async classify(text: string): Promise<JobClassification> {
    const n = norm(text);

    const urgency = classifyUrgency(n);
    const { trade, category, tags } = classifyTradeAndCategory(n);

    return {
      category,
      trade,
      urgency,
      suggestedTags: deriveSuggestedTags(n, tags),
    };
  },
};

export async function classifyJob(text: string, classifier: JobClassifier = heuristicJobClassifier): Promise<JobClassification> {
  return classifier.classify(text);
}
