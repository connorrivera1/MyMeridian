import { useEffect, useState } from "react";
import {
  redirect,
  useLoaderData,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";

import { BrandMark } from "~/design/components";
import { resolveWebUser } from "~/lib/auth.server";
import { APP_NAME } from "~/lib/brand";
import { safeReturnPath } from "~/lib/web-oauth.server";
import { claimWelcome } from "~/lib/webauth.server";

export const meta = () => [{ title: `Welcome to ${APP_NAME}` }];

/** Long enough to read two lines without becoming a wait. */
const HOLD_MS = 2600;

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  /*
   * The "already registered" branch of signup lands here with ?pending=1 and
   * no session, on purpose: it must look exactly like a successful signup, or
   * the difference tells a stranger whether an address has an account.
   */
  const pending = url.searchParams.get("pending") === "1";
  const user = await resolveWebUser(request);

  if (!user) {
    if (pending) return { next: "/login", claimed: true };
    throw redirect("/login");
  }

  const next = safeReturnPath(url.searchParams.get("next"));

  /*
   * One claim, ever. `claimWelcome` is a conditional update on `welcomedAt`,
   * so a second visit — a refresh, a bookmark, a sign-in from another device —
   * loses the race and is sent straight on. This is what makes the screen
   * "only after they sign up for the first time" rather than "whenever they
   * happen to hit this URL".
   */
  const claimed = await claimWelcome(user.id);
  if (!claimed) throw redirect(next);

  return { next, claimed };
}

export default function Welcome() {
  const { next } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hold = reduced ? 1200 : HOLD_MS;

    const toFade = window.setTimeout(() => setLeaving(true), hold);
    const toGo = window.setTimeout(() => navigate(next, { replace: true }), hold + 320);

    return () => {
      window.clearTimeout(toFade);
      window.clearTimeout(toGo);
    };
  }, [navigate, next]);

  return (
    <div className={leaving ? "splash welcome-splash out" : "splash welcome-splash"}>
      <div className="welcome-inner">
        <div className="splash-globe">
          <BrandMark size={104} spin />
        </div>

        <h1 className="welcome-word">
          {["Welcome", "to", APP_NAME].map((word, i) => (
            <span key={word} style={{ animationDelay: `${0.34 + i * 0.11}s` }}>
              {word}
            </span>
          ))}
        </h1>

        <p className="welcome-sub">You will receive your confirmation shortly</p>

        {/* Never a jail: the auto-advance is a courtesy, not the only exit. */}
        <button
          type="button"
          className="welcome-skip"
          onClick={() => navigate(next, { replace: true })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
