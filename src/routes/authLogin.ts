import type { Response } from "express";

export type AuthLoginRequest = {
  validated: {
    body: {
      email: string;
      password: string;
    };
  };
};

export type AuthUserRow = {
  id: number;
  role: string;
  name: string | null;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  subscription?: { tier: string } | null;
};

export type LoginBruteForceLike = {
  check: (args: { req: any; email: string }) => Promise<
    | { allowed: true }
    | { allowed: false; reason: string; retryAfterSeconds: number }
  >;
  onFailure: (args: { req: any; email: string }) => Promise<{
    ipCount: number;
    identCount: number;
    cooldownTriggered: "ip" | "identity" | null;
  }>;
  onSuccess: (args: { req: any; email: string }) => Promise<{ ok: true } | any>;
};

export function createAuthLoginHandler(deps: {
  prisma: {
    user: {
      findUnique: (args: any) => Promise<AuthUserRow | null>;
    };
  };
  bcryptCompare: (password: string, hash: string) => Promise<boolean>;
  jwtSign: (payload: any, secret: string, opts: any) => string;
  jwtSecret: string;
  logSecurityEvent: (req: any, type: string, metadata: any) => Promise<void>;
  loginBruteForce: LoginBruteForceLike;
}) {
  const { prisma, bcryptCompare, jwtSign, jwtSecret, logSecurityEvent, loginBruteForce } = deps;

  return async (req: any, res: Response) => {
    try {
      const { email, password } = (req as AuthLoginRequest).validated.body;

      const throttle = await loginBruteForce.check({ req, email });
      if (throttle.allowed === false) {
        await logSecurityEvent(req, "auth.login_throttled", {
          actorEmail: email,
          reason: throttle.reason,
          retryAfterSeconds: throttle.retryAfterSeconds,
        });
        res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
        return res.status(429).json({ error: "Too many login attempts. Try again later." });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        include: { subscription: true },
      });

      if (!user) {
        const r = await loginBruteForce.onFailure({ req, email });

        if (r.cooldownTriggered) {
          await logSecurityEvent(req, "auth.login_lockout", {
            actorEmail: email,
            reason: "cooldown_triggered",
            dimension: r.cooldownTriggered,
            ipFailCount: r.ipCount,
            identityFailCount: r.identCount,
          });
          return res.status(429).json({ error: "Too many login attempts. Try again later." });
        }

        await logSecurityEvent(req, "auth.login_failed", {
          actorEmail: email,
          reason: "user_not_found",
        });

        // Do not reveal whether an email exists.
        return res.status(401).json({ error: "Invalid email or password." });
      }

      const isValid = await bcryptCompare(String(password), user.passwordHash);

      if (!isValid) {
        const r = await loginBruteForce.onFailure({ req, email: user.email });

        if (r.cooldownTriggered) {
          await logSecurityEvent(req, "auth.login_lockout", {
            actorUserId: user.id,
            actorRole: user.role,
            actorEmail: user.email,
            reason: "cooldown_triggered",
            dimension: r.cooldownTriggered,
            ipFailCount: r.ipCount,
            identityFailCount: r.identCount,
          });
          return res.status(429).json({ error: "Too many login attempts. Try again later." });
        }

        await logSecurityEvent(req, "auth.login_failed", {
          actorUserId: user.id,
          actorRole: user.role,
          actorEmail: user.email,
          reason: "bad_password",
        });

        // Do not reveal whether an email exists.
        return res.status(401).json({ error: "Invalid email or password." });
      }

      await loginBruteForce.onSuccess({ req, email: user.email });

      await logSecurityEvent(req, "auth.login", {
        actorUserId: user.id,
        actorRole: user.role,
        actorEmail: user.email,
        targetType: "USER",
        targetId: user.id,
        emailVerified: Boolean(user.emailVerifiedAt),
      });

      const token = jwtSign(
        {
          userId: user.id,
          role: user.role,
        },
        jwtSecret,
        { expiresIn: "7d" }
      );

      return res.json({
        token,
        user: {
          id: user.id,
          role: user.role,
          name: user.name,
          email: user.email,
          subscriptionTier: user.subscription?.tier ?? "FREE",
          emailVerified: Boolean(user.emailVerifiedAt),
        },
      });
    } catch (err) {
      console.error("Login error:", err);
      return res.status(500).json({ error: "Internal server error during login." });
    }
  };
}
