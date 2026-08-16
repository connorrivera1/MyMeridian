import { Form, redirect, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { unsubscribeWaitlistMarketing, verifyWaitlistUnsubscribeToken } from "~/lib/waitlist.server";
import { requestOriginIsSelf } from "~/lib/web-session.server";

function tokenFromUrl(request: Request): string {
  return new URL(request.url).searchParams.get("t")?.slice(0, 512) ?? "";
}

export function loader({ request }: LoaderFunctionArgs) {
  const token = tokenFromUrl(request);
  if (!verifyWaitlistUnsubscribeToken(token)) throw redirect("/");
  return { token };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) throw redirect("/");
  const form = await request.formData();
  const token = String(form.get("t") ?? "").slice(0, 512);
  if (!(await unsubscribeWaitlistMarketing(token))) throw redirect("/");
  throw redirect("/waitlist/unsubscribed");
}

/** A GET from an email scanner cannot change consent; only this explicit POST can. */
export default function WaitlistUnsubscribe() {
  const { token } = useLoaderData<typeof loader>();
  return (
    <main className="legal-page" style={{ maxWidth: 560, margin: "72px auto", padding: 24 }}>
      <p className="eyebrow">MyMeridian</p>
      <h1>Unsubscribe From Product Updates</h1>
      <p>You will stop receiving marketing and newsletter updates. Necessary account and service notices may still be sent when relevant.</p>
      <Form method="post">
        <input type="hidden" name="t" value={token} />
        <button type="submit">Unsubscribe</button>
      </Form>
    </main>
  );
}
