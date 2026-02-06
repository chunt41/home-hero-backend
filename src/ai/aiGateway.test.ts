import test from "node:test";
import assert from "node:assert/strict";

import {
  AiQuotaExceededError,
  createInMemoryAiGatewayForTest,
  getCurrentMonthKeyUtc,
  type AiQuotaState,
  type AiProvider,
} from "./aiGateway";

test("runAiTask cache hit does not consume quota or call provider", async () => {
  const monthKey = getCurrentMonthKeyUtc();

  const users = new Map<number, AiQuotaState>([
    [
      1,
      {
        aiMonthlyTokenLimit: 1000,
        aiTokensUsedThisMonth: 0,
        aiUsageMonthKey: monthKey,
        tier: "PRO",
      },
    ],
  ]);

  let calls = 0;
  const provider: AiProvider = {
    generateText: async ({ prompt }) => {
      calls += 1;
      return { text: `OUT:${prompt}` };
    },
  };

  const gateway = createInMemoryAiGatewayForTest({ users, provider });

  const first = await gateway.runAiTask({
    userId: 1,
    taskType: "summarize.thread",
    input: "Hello   WORLD",
    estimatedTokens: 120,
  });

  assert.equal(first.cached, false);
  assert.equal(calls, 1);
  assert.equal(users.get(1)?.aiTokensUsedThisMonth, 120);

  const second = await gateway.runAiTask({
    userId: 1,
    taskType: "summarize.thread",
    input: "  hello world ",
    estimatedTokens: 120,
  });

  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(calls, 1);
  assert.equal(users.get(1)?.aiTokensUsedThisMonth, 120);
});

test("quota exceeded blocks provider call", async () => {
  const monthKey = getCurrentMonthKeyUtc();

  const users = new Map<number, AiQuotaState>([
    [
      1,
      {
        aiMonthlyTokenLimit: 10,
        aiTokensUsedThisMonth: 10,
        aiUsageMonthKey: monthKey,
        tier: "PRO",
      },
    ],
  ]);

  let calls = 0;
  const provider: AiProvider = {
    generateText: async () => {
      calls += 1;
      return { text: "should-not-run" };
    },
  };

  const gateway = createInMemoryAiGatewayForTest({ users, provider });

  await assert.rejects(
    () =>
      gateway.runAiTask({
        userId: 1,
        taskType: "rewrite.message",
        input: "hi",
        estimatedTokens: 1,
      }),
    (err: any) => {
      assert.equal(err instanceof AiQuotaExceededError, true);
      assert.equal(err.code, "AI_QUOTA_EXCEEDED");
      return true;
    }
  );

  assert.equal(calls, 0);
});

test("model selection: PRO + allowlisted task uses premium model", async () => {
  const prevPremium = process.env.AI_MODEL_PREMIUM;
  const prevCheap = process.env.AI_MODEL_CHEAP;
  process.env.AI_MODEL_PREMIUM = "premium-model-test";
  process.env.AI_MODEL_CHEAP = "cheap-model-test";

  try {
    const monthKey = getCurrentMonthKeyUtc();
    const users = new Map<number, AiQuotaState>([
      [
        1,
        {
          aiMonthlyTokenLimit: 1000,
          aiTokensUsedThisMonth: 0,
          aiUsageMonthKey: monthKey,
          tier: "PRO",
        },
      ],
    ]);

    let lastModel: string | null = null;
    const provider: AiProvider = {
      generateText: async ({ model }) => {
        lastModel = model;
        return { text: "ok" };
      },
    };

    const gateway = createInMemoryAiGatewayForTest({ users, provider });
    const out = await gateway.runAiTask({
      userId: 1,
      taskType: "draft.bid",
      input: "Draft a bid",
      estimatedTokens: 50,
    });

    assert.equal(out.model, "premium");
    assert.equal(lastModel, "premium-model-test");
  } finally {
    if (typeof prevPremium === "undefined") delete process.env.AI_MODEL_PREMIUM;
    else process.env.AI_MODEL_PREMIUM = prevPremium;

    if (typeof prevCheap === "undefined") delete process.env.AI_MODEL_CHEAP;
    else process.env.AI_MODEL_CHEAP = prevCheap;
  }
});

test("model selection: non-PRO never uses premium model", async () => {
  const prevPremium = process.env.AI_MODEL_PREMIUM;
  const prevCheap = process.env.AI_MODEL_CHEAP;
  process.env.AI_MODEL_PREMIUM = "premium-model-test";
  process.env.AI_MODEL_CHEAP = "cheap-model-test";

  try {
    const monthKey = getCurrentMonthKeyUtc();
    const users = new Map<number, AiQuotaState>([
      [
        1,
        {
          aiMonthlyTokenLimit: 1000,
          aiTokensUsedThisMonth: 0,
          aiUsageMonthKey: monthKey,
          tier: "BASIC",
        },
      ],
    ]);

    let lastModel: string | null = null;
    const provider: AiProvider = {
      generateText: async ({ model }) => {
        lastModel = model;
        return { text: "ok" };
      },
    };

    const gateway = createInMemoryAiGatewayForTest({ users, provider });
    const out = await gateway.runAiTask({
      userId: 1,
      taskType: "draft.bid",
      input: "Draft a bid",
      estimatedTokens: 50,
    });

    assert.equal(out.model, "cheap");
    assert.equal(lastModel, "cheap-model-test");
  } finally {
    if (typeof prevPremium === "undefined") delete process.env.AI_MODEL_PREMIUM;
    else process.env.AI_MODEL_PREMIUM = prevPremium;

    if (typeof prevCheap === "undefined") delete process.env.AI_MODEL_CHEAP;
    else process.env.AI_MODEL_CHEAP = prevCheap;
  }
});
