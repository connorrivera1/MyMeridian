/**
 * "Continue with Google", "Continue with Microsoft" and "Continue with Apple".
 *
 * All three are OpenID Connect authorisation-code flows, and all are optional:
 * MyMeridian boots and serves email/password sign-in with neither configured,
 * the same way `hasShopifyCredentials` lets the app run before it has Shopify
 * keys. The signed-out pages always show each supported provider so merchants
 * know the option exists; an unconfigured provider returns a clear, neutral
 * message rather than failing at its redirect.
 *
 * Apple is the more demanding provider. Its client secret is not a string
 * you paste in — it is an ES256 JWT you sign yourself, valid for at most six
 * months, and it has to be minted per request rather than stored.
 */

import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

/* --------------------------------------------------------- configuration */

export interface ProviderConfig {
  clientId: string;
  /** Google and Microsoft. Apple derives its secret from a signing key instead. */
  clientSecret?: string;
  /** Apple only. */
  teamId?: string;
  keyId?: string;
  privateKey?: string;
  /** Microsoft only. `common` permits both work/school and personal accounts. */
  tenantId?: string;
}

function googleConfig(): ProviderConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function appleConfig(): ProviderConfig | null {
  const clientId = process.env.APPLE_CLIENT_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  // Stored with literal \n so it survives a single-line secret store.
  const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !teamId || !keyId || !privateKey) return null;
  return { clientId, teamId, keyId, privateKey };
}

/**
 * Apple provides the signing key as a PEM-formatted `.p8` file. Treat a
 * malformed value as an unavailable provider instead of discovering it only
 * after Apple has redirected a person back to the callback endpoint.
 */
function usableApplePrivateKey(config: ProviderConfig | null): boolean {
  if (!config?.privateKey) return false;
  try {
    createPrivateKey(config.privateKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * A Microsoft authority segment is part of the server-controlled URL. Keep it
 * deliberately narrow so an environment typo cannot turn into a different
 * host or path. `common` supports the work/school accounts businesses use and
 * personal Microsoft accounts; an organization can optionally pin a tenant.
 */
function microsoftTenantId(): string | null {
  const value = process.env.MICROSOFT_TENANT_ID?.trim() || "common";
  if (!/^[a-z0-9][a-z0-9.-]{0,251}$/i.test(value)) return null;
  if (value.includes("..")) return null;
  return value;
}

function microsoftConfig(): ProviderConfig | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = microsoftTenantId();
  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId };
}

export function googleIsConfigured(): boolean {
  return googleConfig() !== null;
}

export function appleIsConfigured(): boolean {
  return usableApplePrivateKey(appleConfig());
}

export function microsoftIsConfigured(): boolean {
  return microsoftConfig() !== null;
}

/** Which providers currently have working credentials. */
export function configuredProviders(): Array<"GOOGLE" | "MICROSOFT" | "APPLE"> {
  const providers: Array<"GOOGLE" | "MICROSOFT" | "APPLE"> = [];
  if (googleIsConfigured()) providers.push("GOOGLE");
  if (microsoftIsConfigured()) providers.push("MICROSOFT");
  if (appleIsConfigured()) providers.push("APPLE");
  return providers;
}


/* ------------------------------------------------------------ PKCE/state */

export interface AuthorizationStart {
  url: string;
  /** Opaque value to store in a cookie and compare on the way back. */
  state: string;
  nonce: string;
  codeVerifier: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * The cookie that carries state, nonce and PKCE verifier across the redirect.
 *
 * Packed into one value rather than three cookies so a partial expiry cannot
 * leave two thirds of a handshake behind, which would fail in a way that reads
 * as the provider rejecting the login.
 */
export function packHandshake(h: {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}): string {
  return base64url(Buffer.from(JSON.stringify(h)));
}

export function unpackHandshake(
  packed: string | null,
): { state: string; nonce: string; codeVerifier: string; returnTo: string } | null {
  if (!packed) return null;
  try {
    const parsed = JSON.parse(Buffer.from(packed, "base64url").toString("utf8"));
    if (
      typeof parsed?.state !== "string" ||
      typeof parsed?.nonce !== "string" ||
      typeof parsed?.codeVerifier !== "string"
    ) {
      return null;
    }
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      codeVerifier: parsed.codeVerifier,
      // An absent or non-string returnTo is not a failure — it just means
      // "land on the default page".
      returnTo: typeof parsed.returnTo === "string" ? parsed.returnTo : "/app",
    };
  } catch {
    return null;
  }
}

/**
 * Where to send someone after sign-in.
 *
 * Only a path on this site is ever accepted. Echoing an absolute URL back into
 * a redirect is the open-redirect that turns a legitimate login link into
 * phishing, and `//evil.test` is a protocol-relative URL rather than a path,
 * which is the form that usually slips through a naive leading-slash check.
 */
export function safeReturnPath(raw: string | null): string {
  if (!raw) return "/app";
  if (!raw.startsWith("/")) return "/app";
  if (raw.startsWith("//")) return "/app";
  if (raw.startsWith("/\\")) return "/app";
  return raw;
}

/* ---------------------------------------------------------------- Google */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function startGoogle(redirectUri: string): AuthorizationStart | null {
  const config = googleConfig();
  if (!config) return null;

  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(32));
  const challenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { url: url.toString(), state, nonce, codeVerifier };
}

/* ------------------------------------------------------------- Microsoft */

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";

function microsoftAuthorizeEndpoint(tenantId: string): string {
  return `${MICROSOFT_AUTHORITY}/${tenantId}/oauth2/v2.0/authorize`;
}

function microsoftTokenEndpoint(tenantId: string): string {
  return `${MICROSOFT_AUTHORITY}/${tenantId}/oauth2/v2.0/token`;
}

export function startMicrosoft(redirectUri: string): AuthorizationStart | null {
  const config = microsoftConfig();
  if (!config?.tenantId) return null;

  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(32));
  const challenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );

  const url = new URL(microsoftAuthorizeEndpoint(config.tenantId));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { url: url.toString(), state, nonce, codeVerifier };
}

/* ----------------------------------------------------------------- Apple */

const APPLE_AUTH = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN = "https://appleid.apple.com/auth/token";
const APPLE_ISSUER = "https://appleid.apple.com";

/**
 * Mint Apple's client secret.
 *
 * ES256 signatures come out of most libraries as DER, and Apple requires the
 * raw 64-byte R‖S form that JWS specifies. `dsaEncoding: "ieee-p1363"` asks
 * node for exactly that; without it Apple rejects the secret as malformed,
 * which surfaces as `invalid_client` and reads like a wrong key id.
 *
 * Apple caps the lifetime at six months. Five minutes is used instead because
 * the secret is minted per request and never stored, so a long life buys
 * nothing and only widens the window if one leaks.
 */
export function mintAppleClientSecret(now: Date = new Date()): string | null {
  const config = appleConfig();
  if (!config?.privateKey || !config.teamId || !config.keyId) return null;

  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: "ES256", kid: config.keyId, typ: "JWT" };
  const payload = {
    iss: config.teamId,
    iat: issuedAt,
    exp: issuedAt + 300,
    aud: APPLE_ISSUER,
    sub: config.clientId,
  };

  const signingInput = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(payload))),
  ].join(".");

  let signature: Buffer;
  try {
    signature = sign(
      "sha256",
      Buffer.from(signingInput),
      {
        key: createPrivateKey(config.privateKey),
        dsaEncoding: "ieee-p1363",
      },
    );
  } catch {
    return null;
  }

  return `${signingInput}.${base64url(signature)}`;
}

export function startApple(redirectUri: string): AuthorizationStart | null {
  const config = appleConfig();
  if (!config || !usableApplePrivateKey(config)) return null;

  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(32));

  const url = new URL(APPLE_AUTH);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "name email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  /*
   * Apple only releases name and email with form_post, and it posts to the
   * callback cross-site. That POST therefore arrives without a SameSite=Lax
   * cookie — which is why the handshake cookie is written SameSite=None for
   * Apple specifically, and why the callback is a POST handler.
   */
  url.searchParams.set("response_mode", "form_post");

  return { url: url.toString(), state, nonce, codeVerifier };
}

/* ------------------------------------------------------- token + id_token */

export interface IdentityClaims {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Read an id_token's payload.
 *
 * The signature is deliberately not checked here, and that is sound rather
 * than a shortcut: this token was just received in the body of a direct,
 * TLS-authenticated POST to the provider's own token endpoint, which OIDC Core
 * §3.1.3.7 explicitly allows as an alternative to signature validation. It
 * would NOT be sound for a token arriving from the browser — an implicit-flow
 * id_token must have its signature checked against the provider's JWKS.
 *
 * The registered claims are still validated below, because those defend
 * against a token that is genuine but not for us.
 */
export function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Check the claims that decide whether a valid token is valid *for us*.
 *
 * A token issued for a different client is a real token and would decode
 * cleanly; `aud` is what stops it being accepted. `nonce` ties the response to
 * the request this browser started, which is what makes a replayed token
 * useless.
 */
export function claimsAreAcceptable(
  claims: Record<string, unknown>,
  expected: { issuers: string[]; clientId: string; nonce: string },
  now: Date = new Date(),
): boolean {
  const iss = typeof claims.iss === "string" ? claims.iss : null;
  if (!iss || !expected.issuers.includes(iss)) return false;

  // `aud` is a string or an array of strings.
  const aud = claims.aud;
  const audienceMatches =
    aud === expected.clientId ||
    (Array.isArray(aud) && aud.includes(expected.clientId));
  if (!audienceMatches) return false;

  if (typeof claims.exp !== "number") return false;
  if (claims.exp * 1000 <= now.getTime()) return false;

  if (claims.nonce !== expected.nonce) return false;

  if (typeof claims.sub !== "string" || claims.sub.length === 0) return false;

  return true;
}

/**
 * Normalise the identity out of a validated claim set.
 *
 * `email_verified` arrives as a boolean from Google and as the string "true"
 * from Apple. Treating the string as truthy without converting it is how an
 * unverified address ends up linked to an existing account.
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  name: string | null,
): IdentityClaims {
  const verified = claims.email_verified;

  return {
    providerUserId: String(claims.sub),
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: verified === true || verified === "true",
    name:
      name ??
      (typeof claims.name === "string" && claims.name.trim() ? claims.name : null),
  };
}

interface TokenResponse {
  id_token?: string;
  error?: string;
}

async function exchangeCode(
  endpoint: string,
  body: URLSearchParams,
): Promise<string | null> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as TokenResponse;
  return payload.id_token ?? null;
}

/** Exchange Google's code and return the identity it asserts. */
export async function completeGoogle(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  nonce: string,
  now: Date = new Date(),
): Promise<IdentityClaims | null> {
  const config = googleConfig();
  if (!config?.clientSecret) return null;

  const idToken = await exchangeCode(
    GOOGLE_TOKEN,
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  );
  if (!idToken) return null;

  const claims = decodeIdTokenPayload(idToken);
  if (!claims) return null;
  if (
    !claimsAreAcceptable(
      claims,
      { issuers: GOOGLE_ISSUERS, clientId: config.clientId, nonce },
      now,
    )
  ) {
    return null;
  }

  return identityFromClaims(claims, null);
}

/**
 * Microsoft returns a tenant-specific issuer even when the request starts at
 * the `common` authority. Checking it against the signed-in tenant stops an
 * ID token from a different Microsoft authority being accepted here.
 */
export function microsoftClaimsAreAcceptable(
  claims: Record<string, unknown>,
  expected: { clientId: string; nonce: string },
  now: Date = new Date(),
): boolean {
  const tenantId = typeof claims.tid === "string" ? claims.tid : null;
  if (!tenantId || !microsoftTenantIdIsValid(tenantId)) return false;

  return claimsAreAcceptable(
    claims,
    {
      issuers: [`${MICROSOFT_AUTHORITY}/${tenantId}/v2.0`],
      clientId: expected.clientId,
      nonce: expected.nonce,
    },
    now,
  );
}

function microsoftTenantIdIsValid(value: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{0,251}$/i.test(value) && !value.includes("..");
}

/** Exchange Microsoft's authorization code and return its account identity. */
export async function completeMicrosoft(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  nonce: string,
  now: Date = new Date(),
): Promise<IdentityClaims | null> {
  const config = microsoftConfig();
  if (!config?.clientSecret || !config.tenantId) return null;

  const idToken = await exchangeCode(
    microsoftTokenEndpoint(config.tenantId),
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  );
  if (!idToken) return null;

  const claims = decodeIdTokenPayload(idToken);
  if (!claims) return null;
  if (!microsoftClaimsAreAcceptable(claims, { clientId: config.clientId, nonce }, now)) {
    return null;
  }

  // Microsoft only returns an email claim when one is available and does not
  // attach Google's/Apple's `email_verified` claim. Preserve it for display,
  // but do not use it to silently link an existing password account.
  return identityFromClaims(claims, null);
}

/**
 * Exchange Apple's code.
 *
 * `name` is passed separately because Apple sends it in the form post exactly
 * once — on the very first authorisation, never again. It is not in the
 * id_token, so an account created on a later sign-in has no name unless it was
 * captured the first time.
 */
export async function completeApple(
  code: string,
  redirectUri: string,
  nonce: string,
  name: string | null,
  now: Date = new Date(),
): Promise<IdentityClaims | null> {
  const config = appleConfig();
  if (!config) return null;

  const clientSecret = mintAppleClientSecret(now);
  if (!clientSecret) return null;

  const idToken = await exchangeCode(
    APPLE_TOKEN,
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );
  if (!idToken) return null;

  const claims = decodeIdTokenPayload(idToken);
  if (!claims) return null;
  if (
    !claimsAreAcceptable(
      claims,
      { issuers: [APPLE_ISSUER], clientId: config.clientId, nonce },
      now,
    )
  ) {
    return null;
  }

  return identityFromClaims(claims, name);
}
