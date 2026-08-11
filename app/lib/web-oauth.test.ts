import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const {
  appleIsConfigured,
  claimsAreAcceptable,
  configuredProviders,
  decodeIdTokenPayload,
  googleIsConfigured,
  identityFromClaims,
  mintAppleClientSecret,
  packHandshake,
  safeReturnPath,
  startApple,
  startGoogle,
  unpackHandshake,
} = await import("./web-oauth.server");

const { providerNotice } = await import("./provider-notice");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "APPLE_CLIENT_ID",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function configureGoogle() {
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
}

function configureApple() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APPLE_CLIENT_ID = "app.mymeridian.web";
  process.env.APPLE_TEAM_ID = "TEAM123456";
  process.env.APPLE_KEY_ID = "KEY1234567";
  process.env.APPLE_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

/* --------------------------------------------------------- configuration */

describe("provider configuration", () => {
  it("offers nothing when neither provider is configured", () => {
    // The app has to boot and serve email sign-in with no third-party keys,
    // the same way it boots without Shopify credentials.
    expect(configuredProviders()).toEqual([]);
    expect(googleIsConfigured()).toBe(false);
    expect(appleIsConfigured()).toBe(false);
  });

  it("requires every field, not just the first", () => {
    process.env.GOOGLE_CLIENT_ID = "google-client";
    expect(googleIsConfigured()).toBe(false);

    process.env.APPLE_CLIENT_ID = "x";
    process.env.APPLE_TEAM_ID = "y";
    // Missing key id and private key.
    expect(appleIsConfigured()).toBe(false);
  });

  it("offers each provider once it is fully configured", () => {
    configureGoogle();
    configureApple();
    expect(configuredProviders()).toEqual(["GOOGLE", "APPLE"]);
  });

  it("refuses to start a flow for an unconfigured provider", () => {
    expect(startGoogle("https://x.test/cb")).toBeNull();
    expect(startApple("https://x.test/cb")).toBeNull();
  });

});

describe("provider notices", () => {
  it("explains an unavailable provider rather than showing a 404", () => {
    expect(providerNotice("google-unavailable")).toMatch(/Google/);
    expect(providerNotice("apple-unavailable")).toMatch(/Apple/);
  });

  it("says nothing for no code or an unrecognised one", () => {
    // An arbitrary ?error= in the URL must not render attacker-chosen text.
    expect(providerNotice(null)).toBeNull();
    expect(providerNotice("<script>alert(1)</script>")).toBeNull();
    expect(providerNotice("made-up")).toBeNull();
  });
});

/* -------------------------------------------------------- authorization */

describe("starting an authorization", () => {
  it("sends PKCE, state and nonce to Google", () => {
    configureGoogle();
    const start = startGoogle("https://x.test/oauth/google/callback")!;
    const url = new URL(start.url);

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("nonce")).toBe(start.nonce);
    // The verifier itself must never leave the server.
    expect(start.url).not.toContain(start.codeVerifier);
  });

  it("asks Apple for form_post, which is the only way it releases a name", () => {
    configureApple();
    const start = startApple("https://x.test/oauth/apple/callback")!;
    const url = new URL(start.url);

    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.searchParams.get("scope")).toBe("name email");
  });

  it("issues a fresh state and nonce every time", () => {
    configureGoogle();
    const a = startGoogle("https://x.test/cb")!;
    const b = startGoogle("https://x.test/cb")!;

    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

/* ------------------------------------------------------------- handshake */

describe("handshake packing", () => {
  it("round-trips", () => {
    const packed = packHandshake({
      state: "s",
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/app/orders",
    });

    expect(unpackHandshake(packed)).toEqual({
      state: "s",
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/app/orders",
    });
  });

  it("treats a missing or damaged cookie as no handshake", () => {
    // Which the callback then rejects — the same outcome as a forged one.
    expect(unpackHandshake(null)).toBeNull();
    expect(unpackHandshake("not-base64url-json")).toBeNull();
    expect(unpackHandshake(Buffer.from('{"state":1}').toString("base64url"))).toBeNull();
  });

  it("defaults a missing return path rather than failing the sign-in", () => {
    const packed = Buffer.from(
      JSON.stringify({ state: "s", nonce: "n", codeVerifier: "v" }),
    ).toString("base64url");

    expect(unpackHandshake(packed)?.returnTo).toBe("/app");
  });
});

describe("return paths", () => {
  it("keeps a path on this site", () => {
    expect(safeReturnPath("/app/orders?range=30d")).toBe("/app/orders?range=30d");
  });

  it("refuses anything that could leave the site", () => {
    // `//evil.test` is the one that usually slips through a naive check for a
    // leading slash: it is protocol-relative, not a path.
    for (const hostile of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "javascript:alert(1)",
      null,
    ]) {
      expect(safeReturnPath(hostile), String(hostile)).toBe("/app");
    }
  });
});

/* ----------------------------------------------------------- Apple secret */

describe("Apple client secret", () => {
  it("is null when Apple is not configured", () => {
    expect(mintAppleClientSecret()).toBeNull();
  });

  it("is an ES256 JWT with a raw 64-byte signature", () => {
    configureApple();
    const now = new Date("2026-08-11T12:00:00Z");
    const jwt = mintAppleClientSecret(now)!;

    const [rawHeader, rawPayload, rawSignature] = jwt.split(".");
    const header = JSON.parse(Buffer.from(rawHeader!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(rawPayload!, "base64url").toString());

    expect(header).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.aud).toBe("https://appleid.apple.com");
    expect(payload.sub).toBe("app.mymeridian.web");
    expect(payload.exp - payload.iat).toBe(300);

    /*
     * JWS requires the raw R‖S form. Node signs to DER unless asked otherwise,
     * and DER is 70-72 bytes with a 0x30 header — Apple rejects that as
     * invalid_client, which reads like a wrong key id rather than a wrong
     * encoding.
     */
    const signature = Buffer.from(rawSignature!, "base64url");
    expect(signature.length).toBe(64);
    expect(signature[0]).not.toBe(0x30);
  });
});

/* ------------------------------------------------------------- id_token */

describe("id_token claims", () => {
  const base = {
    iss: "https://accounts.google.com",
    aud: "google-client",
    sub: "sub-1",
    nonce: "nonce-1",
    exp: Math.floor(new Date("2026-08-11T13:00:00Z").getTime() / 1000),
  };
  const expected = {
    issuers: ["https://accounts.google.com"],
    clientId: "google-client",
    nonce: "nonce-1",
  };
  const now = new Date("2026-08-11T12:00:00Z");

  it("decodes a payload, and refuses a malformed token", () => {
    const token = `x.${Buffer.from(JSON.stringify(base)).toString("base64url")}.y`;
    expect(decodeIdTokenPayload(token)).toEqual(base);

    expect(decodeIdTokenPayload("not.a.jwt")).toBeNull();
    expect(decodeIdTokenPayload("onlyonepart")).toBeNull();
  });

  it("accepts a token issued for us", () => {
    expect(claimsAreAcceptable(base, expected, now)).toBe(true);
  });

  it("accepts an audience array containing our client id", () => {
    expect(
      claimsAreAcceptable({ ...base, aud: ["other", "google-client"] }, expected, now),
    ).toBe(true);
  });

  /**
   * Each of these is a token that is genuine but not ours to accept, which is
   * the whole reason the registered claims are checked at all.
   */
  it("rejects a token that is real but not for this request", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["wrong issuer", { ...base, iss: "https://evil.test" }],
      ["missing issuer", { ...base, iss: undefined }],
      ["another client's audience", { ...base, aud: "someone-else" }],
      ["audience array without us", { ...base, aud: ["a", "b"] }],
      ["expired", { ...base, exp: Math.floor(now.getTime() / 1000) - 1 }],
      ["no expiry", { ...base, exp: undefined }],
      ["replayed with a stale nonce", { ...base, nonce: "old-nonce" }],
      ["no subject", { ...base, sub: undefined }],
      ["empty subject", { ...base, sub: "" }],
    ];

    for (const [label, claims] of cases) {
      expect(claimsAreAcceptable(claims, expected, now), label).toBe(false);
    }
  });
});

describe("identity from claims", () => {
  it("reads Google's boolean email_verified", () => {
    const identity = identityFromClaims(
      { sub: "s", email: "a@b.com", email_verified: true, name: "Ada" },
      null,
    );

    expect(identity).toEqual({
      providerUserId: "s",
      email: "a@b.com",
      emailVerified: true,
      name: "Ada",
    });
  });

  it("reads Apple's string email_verified", () => {
    // Apple sends "true", not true. Passing the raw value through as truthy
    // is how an unverified address ends up linked to an existing account.
    expect(
      identityFromClaims({ sub: "s", email: "a@b.com", email_verified: "true" }, null)
        .emailVerified,
    ).toBe(true);
  });

  it("treats anything else as unverified", () => {
    for (const value of [false, "false", undefined, null, 1, "yes"]) {
      expect(
        identityFromClaims({ sub: "s", email: "a@b.com", email_verified: value }, null)
          .emailVerified,
        String(value),
      ).toBe(false);
    }
  });

  it("prefers the name the caller captured, since Apple sends it only once", () => {
    const identity = identityFromClaims({ sub: "s", name: "From Token" }, "From Form");
    expect(identity.name).toBe("From Form");
  });

  it("copes with a hidden email", () => {
    const identity = identityFromClaims({ sub: "s" }, null);
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });
});
