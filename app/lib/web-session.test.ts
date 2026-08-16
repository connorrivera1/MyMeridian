import { describe, expect, it } from "vitest";

import {
  readCookie,
  readSessionToken,
  requestIsSecure,
  requestOriginIsSelf,
  serializeSessionClearCookies,
  serializeSessionCookie,
  sessionCookieName,
} from "./web-session.server";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("cookie naming", () => {
  it("uses the __Host- prefix only where it can be valid", () => {
    // The prefix requires Secure, which plain http cannot set, so a dev server
    // would otherwise emit a cookie every browser silently discards.
    expect(sessionCookieName(true)).toBe("__Host-mymeridian_session");
    expect(sessionCookieName(false)).toBe("mymeridian_session");
  });
});

describe("scheme detection", () => {
  it("trusts x-forwarded-proto over the local protocol", () => {
    // Behind Fly's proxy the connection to node is plain http, so the URL
    // protocol says http on a request the browser made over https.
    expect(
      requestIsSecure(req("http://app.internal/x", { "x-forwarded-proto": "https" })),
    ).toBe(true);
  });

  it("reads the client-facing entry when a proxy chain appended others", () => {
    expect(
      requestIsSecure(
        req("http://app.internal/x", { "x-forwarded-proto": "https, http" }),
      ),
    ).toBe(true);
  });

  it("falls back to the request URL when the header is absent", () => {
    expect(requestIsSecure(req("https://mymeridian.app/x"))).toBe(true);
    expect(requestIsSecure(req("http://localhost:3000/x"))).toBe(false);
  });
});

describe("cookie reading", () => {
  it("finds a cookie among others", () => {
    const r = req("https://x.test/", {
      cookie: "other=1; mymeridian_session=abc123; third=3",
    });
    expect(readCookie(r, "mymeridian_session")).toBe("abc123");
  });

  it("does not match a name by prefix", () => {
    // "mymeridian_session_old" must not be returned for "mymeridian_session".
    const r = req("https://x.test/", { cookie: "mymeridian_session_old=nope" });
    expect(readCookie(r, "mymeridian_session")).toBeNull();
  });

  it("decodes percent-encoding, and treats a malformed value as absent", () => {
    expect(
      readCookie(req("https://x.test/", { cookie: "a=one%20two" }), "a"),
    ).toBe("one two");

    // A bad escape must not throw a 500 out of every route that reads it.
    expect(readCookie(req("https://x.test/", { cookie: "a=%E0%A4%A" }), "a")).toBeNull();
  });

  it("returns null with no cookie header at all", () => {
    expect(readCookie(req("https://x.test/"), "anything")).toBeNull();
  });

  it("finds the token under either name, so http/https moves stay signed in", () => {
    const onHttps = req("https://x.test/", {
      cookie: "mymeridian_session=unprefixed",
    });
    expect(readSessionToken(onHttps)).toBe("unprefixed");

    const onHttp = req("http://x.test/", {
      cookie: "__Host-mymeridian_session=prefixed",
    });
    expect(readSessionToken(onHttp)).toBe("prefixed");
  });
});

describe("cookie serialisation", () => {
  it("is HttpOnly, Lax and Secure on a secure origin", () => {
    const cookie = serializeSessionCookie("tok", true, 100);

    expect(cookie).toContain("__Host-mymeridian_session=tok");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=100");
    // Strict would drop the cookie on the redirect back from Google or Apple,
    // landing a completed sign-in on a logged-out page.
    expect(cookie).toContain("SameSite=Lax");
  });

  it("omits Secure where it cannot be honoured", () => {
    expect(serializeSessionCookie("tok", false, 100)).not.toContain("Secure");
  });

  it("clears both names, and keeps Secure on the __Host- one", () => {
    const cleared = serializeSessionClearCookies();

    expect(cleared).toHaveLength(2);
    for (const cookie of cleared) expect(cookie).toContain("Max-Age=0");

    // Without Secure the browser rejects the whole Set-Cookie for that prefix,
    // and the cookie being cleared would simply survive the logout.
    const hostPrefixed = cleared.find((c) => c.startsWith("__Host-"))!;
    expect(hostPrefixed).toContain("Secure");
  });
});

describe("cross-site request rejection", () => {
  it("accepts a request from our own origin", () => {
    expect(
      requestOriginIsSelf(
        req("https://mymeridian.app/login", { origin: "https://mymeridian.app" }),
      ),
    ).toBe(true);
  });

  it("rejects another origin, including a look-alike host", () => {
    for (const origin of [
      "https://evil.test",
      "https://mymeridian.app.evil.test",
      "null",
      "not-a-url",
    ]) {
      expect(
        requestOriginIsSelf(req("https://mymeridian.app/login", { origin })),
        origin,
      ).toBe(false);
    }
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(
      requestOriginIsSelf(
        req("https://mymeridian.app/login", {
          referer: "https://mymeridian.app/signup",
        }),
      ),
    ).toBe(true);
    expect(
      requestOriginIsSelf(
        req("https://mymeridian.app/login", { referer: "https://evil.test/x" }),
      ),
    ).toBe(false);
  });

  it("rejects a request carrying neither header", () => {
    // Browsers always send Origin on a POST, so something that sends neither
    // is not the browser this form was served to.
    expect(requestOriginIsSelf(req("https://mymeridian.app/login"))).toBe(false);
  });
});
