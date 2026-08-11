import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userCreate = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
const oauthFindUnique = vi.fn();
const oauthCreate = vi.fn();
const sessionCreate = vi.fn();
const sessionFindUnique = vi.fn();
const sessionUpdate = vi.fn();
const sessionUpdateMany = vi.fn();
const tokenCreate = vi.fn();
const tokenFindUnique = vi.fn();
const tokenUpdateMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      create: (...a: unknown[]) => userCreate(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      updateMany: (...a: unknown[]) => userUpdateMany(...a),
    },
    oAuthAccount: {
      findUnique: (...a: unknown[]) => oauthFindUnique(...a),
      create: (...a: unknown[]) => oauthCreate(...a),
    },
    webSession: {
      create: (...a: unknown[]) => sessionCreate(...a),
      findUnique: (...a: unknown[]) => sessionFindUnique(...a),
      update: (...a: unknown[]) => sessionUpdate(...a),
      updateMany: (...a: unknown[]) => sessionUpdateMany(...a),
    },
    emailVerificationToken: {
      create: (...a: unknown[]) => tokenCreate(...a),
      findUnique: (...a: unknown[]) => tokenFindUnique(...a),
      updateMany: (...a: unknown[]) => tokenUpdateMany(...a),
    },
  },
}));

import type { LockoutState } from "./webauth.server";

const {
  MAX_FAILED_LOGINS,
  authenticateWithPassword,
  claimWelcome,
  consumeVerificationToken,
  createPasswordUser,
  createSession,
  emailLooksValid,
  generateToken,
  hashPassword,
  hashToken,
  lockoutRemainingMs,
  nextLockoutState,
  normalizeEmail,
  passwordProblem,
  resolveSession,
  revokeSession,
  sessionIsLive,
  upsertOAuthUser,
  verifyPassword,
} = await import("./webauth.server");

beforeEach(() => {
  vi.clearAllMocks();
});

const NOW = new Date("2026-08-11T12:00:00Z");

/* ------------------------------------------------------------- passwords */

describe("password hashing", () => {
  it("accepts the password it was given and rejects a different one", async () => {
    const hash = await hashPassword("correct horse battery");

    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batteries", hash)).toBe(false);
  });

  it("salts, so the same password never produces the same hash twice", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same input"),
      hashPassword("same input"),
    ]);

    expect(a).not.toEqual(b);
    // Both must still verify: a salt that broke verification would look
    // exactly like a wrong password at the login form.
    expect(await verifyPassword("same input", a)).toBe(true);
    expect(await verifyPassword("same input", b)).toBe(true);
  });

  it("records its cost parameters in the hash", async () => {
    const hash = await hashPassword("parameterised");
    const [scheme, n, r, p] = hash.split("$");

    expect(scheme).toBe("scrypt");
    // If promisify silently drops the options object these become scrypt's
    // defaults while the string still claims 16384 — a hash weaker than it
    // says it is, which nothing else would catch.
    expect(Number(n)).toBe(16_384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it("derives using the parameters in the hash, not a fixed constant", async () => {
    // This is what makes raising the cost later safe: verification re-derives
    // under whatever the stored string says. If it ignored those fields and
    // always used the current constants, tampering with them would change
    // nothing and this would pass as true.
    const hash = await hashPassword("legacy");
    const claimsWeaker = hash.replace(/^scrypt\$16384/, "scrypt$1024");

    expect(await verifyPassword("legacy", hash)).toBe(true);
    expect(await verifyPassword("legacy", claimsWeaker)).toBe(false);
  });

  it("treats every malformed stored hash as a failed login, not an error", async () => {
    const malformed = [
      null,
      "",
      "not-a-hash",
      "scrypt$16384$8$1$onlyfivefields",
      "bcrypt$16384$8$1$c2FsdA==$a2V5",
      "scrypt$abc$8$1$c2FsdA==$a2V5",
      "scrypt$512$8$1$c2FsdA==$a2V5",
      "scrypt$16384$0$1$c2FsdA==$a2V5",
      "scrypt$16384$8$1$$a2V5",
      "scrypt$16384$8$1$c2FsdA==$",
    ];

    for (const stored of malformed) {
      expect(await verifyPassword("anything", stored)).toBe(false);
    }
  });

  it("normalises unicode, so the same typed password matches either encoding", async () => {
    // "é" composed vs decomposed. Two byte sequences, one password as far as
    // the person typing it is concerned.
    const hash = await hashPassword("café pass phrase");
    expect(await verifyPassword("café pass phrase", hash)).toBe(true);
  });
});

describe("password policy", () => {
  it("requires length rather than composition", () => {
    expect(passwordProblem("short")).toMatch(/at least/);
    expect(passwordProblem("a".repeat(10))).toBeNull();
    expect(passwordProblem("all lower case letters no digits")).toBeNull();
  });

  it("bounds the input, so one request cannot buy unbounded scrypt work", () => {
    expect(passwordProblem("x".repeat(513))).toMatch(/too long/);
  });
});

/* ---------------------------------------------------------------- emails */

describe("email handling", () => {
  it("lowercases and trims, so one address cannot register twice", () => {
    expect(normalizeEmail("  Merchant@Example.COM ")).toBe(
      "merchant@example.com",
    );
  });

  it("keeps dots and plus tags, which are not ours to reinterpret", () => {
    // Gmail treats these as equivalent; most providers do not. Stripping them
    // would merge two different people's accounts everywhere else.
    expect(normalizeEmail("a.b+tag@fastmail.com")).toBe("a.b+tag@fastmail.com");
  });

  it("rejects what cannot be an address", () => {
    for (const bad of [
      "",
      "no-at-sign",
      "@example.com",
      "two@@example.com",
      "user@nodot",
      "user@.leading",
      "user@trailing.",
      "user@dou..ble",
      "spaces in@example.com",
      `${"x".repeat(250)}@example.com`,
    ]) {
      expect(emailLooksValid(bad), bad).toBe(false);
    }
  });

  it("accepts ordinary addresses", () => {
    for (const good of [
      "merchant@example.com",
      "a.b+tag@sub.example.co.uk",
      "x@y.io",
    ]) {
      expect(emailLooksValid(good), good).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- tokens */

describe("tokens", () => {
  it("issues distinct, url-safe values", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));

    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes deterministically, and never stores the token itself", () => {
    const token = generateToken();

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* --------------------------------------------------------------- lockout */

describe("lockout", () => {
  const clean: LockoutState = { failedLoginCount: 0, lockedUntil: null };

  it("counts failures and locks at the threshold", () => {
    let state: LockoutState = clean;
    for (let i = 1; i < MAX_FAILED_LOGINS; i++) {
      state = nextLockoutState(state, "failure", NOW);
      expect(state.lockedUntil).toBeNull();
      expect(state.failedLoginCount).toBe(i);
    }

    state = nextLockoutState(state, "failure", NOW);
    expect(state.lockedUntil).not.toBeNull();
    expect(lockoutRemainingMs(state, NOW)).toBeGreaterThan(0);
  });

  it("clears everything on success", () => {
    const locked: LockoutState = { failedLoginCount: 4, lockedUntil: null };
    expect(nextLockoutState(locked, "success", NOW)).toEqual(clean);
  });

  it("does not extend a lock that is already running", () => {
    // Otherwise one failed attempt every few minutes holds the real owner out
    // forever, turning the defence into the attack.
    const lockedUntil = new Date(NOW.getTime() + 60_000);
    const state = { failedLoginCount: 0, lockedUntil };

    const next = nextLockoutState(state, "failure", NOW);
    expect(next.lockedUntil).toBe(lockedUntil);
    expect(next.failedLoginCount).toBe(0);
  });

  it("reports an expired lock as no lock", () => {
    const state = { failedLoginCount: 0, lockedUntil: new Date(NOW.getTime() - 1) };
    expect(lockoutRemainingMs(state, NOW)).toBe(0);

    // And a fresh failure after it expires starts counting again.
    expect(nextLockoutState(state, "failure", NOW).failedLoginCount).toBe(1);
  });
});

/* -------------------------------------------------------------- sessions */

describe("session lifetime", () => {
  it("rejects expired and revoked sessions", () => {
    const live = { expiresAt: new Date(NOW.getTime() + 1000), revokedAt: null };
    expect(sessionIsLive(live, NOW)).toBe(true);

    expect(
      sessionIsLive({ expiresAt: new Date(NOW.getTime() - 1), revokedAt: null }, NOW),
    ).toBe(false);
    expect(sessionIsLive({ ...live, revokedAt: NOW }, NOW)).toBe(false);
  });

  it("stores only the hash of the cookie value", async () => {
    sessionCreate.mockResolvedValue({});
    const token = await createSession("user-1", "Firefox", NOW);

    const data = sessionCreate.mock.calls[0]?.[0].data;
    expect(data.tokenHash).toBe(hashToken(token));
    // A dump of this table must not be enough to log in as anyone.
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it("resolves a live session to its user", async () => {
    const user = { id: "user-1" };
    sessionFindUnique.mockResolvedValue({
      id: "s1",
      user,
      expiresAt: new Date(NOW.getTime() + 1000),
      revokedAt: null,
      lastSeenAt: NOW,
    });

    expect(await resolveSession("tok", NOW)).toBe(user);
  });

  it("refuses an unknown, expired or revoked token", async () => {
    sessionFindUnique.mockResolvedValue(null);
    expect(await resolveSession("tok", NOW)).toBeNull();

    sessionFindUnique.mockResolvedValue({
      id: "s1",
      user: { id: "u" },
      expiresAt: new Date(NOW.getTime() - 1),
      revokedAt: null,
      lastSeenAt: NOW,
    });
    expect(await resolveSession("tok", NOW)).toBeNull();

    sessionFindUnique.mockResolvedValue({
      id: "s1",
      user: { id: "u" },
      expiresAt: new Date(NOW.getTime() + 1000),
      revokedAt: NOW,
      lastSeenAt: NOW,
    });
    expect(await resolveSession("tok", NOW)).toBeNull();
  });

  it("short-circuits a missing cookie without touching the database", async () => {
    // Every request from a logged-out visitor takes this path, including the
    // embedded Shopify app's.
    expect(await resolveSession(null, NOW)).toBeNull();
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });

  it("slides expiry at most once a day", async () => {
    const base = {
      id: "s1",
      user: { id: "u" },
      expiresAt: new Date(NOW.getTime() + 1000),
      revokedAt: null,
    };

    sessionFindUnique.mockResolvedValue({ ...base, lastSeenAt: NOW });
    await resolveSession("tok", NOW);
    expect(sessionUpdate).not.toHaveBeenCalled();

    sessionFindUnique.mockResolvedValue({
      ...base,
      lastSeenAt: new Date(NOW.getTime() - 86_400_001),
    });
    await resolveSession("tok", NOW);
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
  });

  it("revokes rather than deletes, so a stolen token stays known-bad", async () => {
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    await revokeSession("tok", NOW);

    const call = sessionUpdateMany.mock.calls[0]?.[0];
    expect(call.where.tokenHash).toBe(hashToken("tok"));
    expect(call.data.revokedAt).toBe(NOW);
  });
});

/* ---------------------------------------------------------------- signup */

describe("signup", () => {
  it("creates an account for a new address", async () => {
    userFindUnique.mockResolvedValue(null);
    userCreate.mockImplementation(({ data }: { data: unknown }) => ({
      id: "u1",
      ...(data as object),
    }));

    const result = await createPasswordUser("New@Example.com", "a-good-password", " Ada ");

    expect(result.ok).toBe(true);
    const data = userCreate.mock.calls[0]?.[0].data;
    expect(data.email).toBe("new@example.com");
    expect(data.name).toBe("Ada");
    expect(data.passwordHash).not.toBe("a-good-password");
  });

  it("does not reveal that an address is already registered", async () => {
    // The signup form is public. An honest "already taken" turns it into a
    // membership oracle for any list of addresses.
    userFindUnique.mockResolvedValue({ id: "existing" });

    const result = await createPasswordUser(
      "taken@example.com",
      "a-good-password",
      null,
    );

    expect(result.ok).toBe(true);
    expect(result.user).toBeUndefined();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("rejects a bad address or a weak password before any write", async () => {
    expect((await createPasswordUser("nope", "a-good-password", null)).ok).toBe(false);
    expect((await createPasswordUser("a@b.com", "short", null)).ok).toBe(false);
    expect(userCreate).not.toHaveBeenCalled();
  });
});

describe("login", () => {
  it("accepts the right password and clears the failure count", async () => {
    const passwordHash = await hashPassword("a-good-password");
    userFindUnique.mockResolvedValue({
      id: "u1",
      passwordHash,
      failedLoginCount: 3,
      lockedUntil: null,
    });

    const result = await authenticateWithPassword("a@b.com", "a-good-password", NOW);

    expect(result.status).toBe("ok");
    expect(userUpdate.mock.calls[0]?.[0].data).toEqual({
      failedLoginCount: 0,
      lockedUntil: null,
    });
  });

  it("gives one answer for a wrong password and a missing account", async () => {
    const passwordHash = await hashPassword("a-good-password");

    userFindUnique.mockResolvedValue({
      id: "u1",
      passwordHash,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    const wrong = await authenticateWithPassword("a@b.com", "not-it", NOW);

    userFindUnique.mockResolvedValue(null);
    const missing = await authenticateWithPassword("nobody@b.com", "not-it", NOW);

    expect(wrong.status).toBe("invalid");
    expect(missing.status).toBe("invalid");
  });

  it("rejects an account that has no password at all", async () => {
    // Apple/Google-only accounts. Without this a null hash could compare
    // equal to something and hand over the account.
    userFindUnique.mockResolvedValue({
      id: "u1",
      passwordHash: null,
      failedLoginCount: 0,
      lockedUntil: null,
    });

    const result = await authenticateWithPassword("a@b.com", "anything", NOW);
    expect(result.status).toBe("invalid");
  });

  it("refuses while locked, without checking the password", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      passwordHash: await hashPassword("a-good-password"),
      failedLoginCount: 0,
      lockedUntil: new Date(NOW.getTime() + 60_000),
    });

    const result = await authenticateWithPassword("a@b.com", "a-good-password", NOW);

    expect(result.status).toBe("locked");
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

/* ----------------------------------------------------------------- oauth */

describe("third-party sign-in", () => {
  const input = {
    provider: "GOOGLE" as const,
    providerUserId: "google-sub-1",
    email: "merchant@example.com",
    emailVerified: true,
    name: "Ada",
  };

  it("returns the existing user for a known provider subject", async () => {
    const user = { id: "u1" };
    oauthFindUnique.mockResolvedValue({ user });

    expect(await upsertOAuthUser(input)).toEqual({ user, created: false });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("links to a password account when the provider verified the address", async () => {
    oauthFindUnique.mockResolvedValue(null);
    const existing = { id: "u1", email: "merchant@example.com" };
    userFindUnique.mockResolvedValue(existing);

    const result = await upsertOAuthUser(input);

    expect(result).toEqual({ user: existing, created: false });
    expect(oauthCreate).toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("never links on an unverified provider address", async () => {
    // Linking on an unverified email is account takeover: anyone who can get a
    // provider to assert an address they do not own inherits that account.
    oauthFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ id: "victim" });
    userCreate.mockResolvedValue({ id: "fresh" });

    const result = await upsertOAuthUser({ ...input, emailVerified: false });

    expect(result.created).toBe(true);
    expect(result.user).toEqual({ id: "fresh" });
    expect(oauthCreate).not.toHaveBeenCalled();
  });

  it("creates a stable synthetic address when the provider hides the email", async () => {
    // Apple's "hide my email". The column is unique and non-null, and a random
    // value would create a new account on every sign-in.
    oauthFindUnique.mockResolvedValue(null);
    userCreate.mockResolvedValue({ id: "u2" });

    await upsertOAuthUser({
      provider: "APPLE",
      providerUserId: "apple-sub-9",
      email: null,
      emailVerified: false,
      name: null,
    });

    const data = userCreate.mock.calls[0]?.[0].data;
    expect(data.email).toContain("apple-sub-9");
    // Nobody proved this address, so it must not be marked verified.
    expect(data.emailVerifiedAt).toBeNull();
  });
});

/* ----------------------------------------------------- welcome and email */

describe("welcome claim", () => {
  it("succeeds once and never again", async () => {
    userUpdateMany.mockResolvedValueOnce({ count: 1 });
    expect(await claimWelcome("u1", NOW)).toBe(true);

    // The second caller loses the conditional update, which is what stops two
    // tabs finishing signup together from both showing the splash.
    userUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await claimWelcome("u1", NOW)).toBe(false);

    expect(userUpdateMany.mock.calls[0]?.[0].where.welcomedAt).toBeNull();
  });
});

describe("email confirmation", () => {
  it("verifies the account and consumes the token", async () => {
    const user = { id: "u1" };
    tokenFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      user,
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    tokenUpdateMany.mockResolvedValue({ count: 1 });

    expect(await consumeVerificationToken("tok", NOW)).toBe(user);
    expect(userUpdate.mock.calls[0]?.[0].data.emailVerifiedAt).toBe(NOW);
  });

  it("refuses an unknown, expired or already-used token", async () => {
    tokenFindUnique.mockResolvedValue(null);
    expect(await consumeVerificationToken("tok", NOW)).toBeNull();

    tokenFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      user: {},
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() - 1),
    });
    expect(await consumeVerificationToken("tok", NOW)).toBeNull();

    tokenFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      user: {},
      consumedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    expect(await consumeVerificationToken("tok", NOW)).toBeNull();
  });

  it("lets only one of two simultaneous clicks win", async () => {
    tokenFindUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      user: {},
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    // The row was consumed between the read and the write.
    tokenUpdateMany.mockResolvedValue({ count: 0 });

    expect(await consumeVerificationToken("tok", NOW)).toBeNull();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
