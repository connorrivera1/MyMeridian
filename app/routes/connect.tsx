import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  Form,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AccountShell, Field, FormError } from "~/design/account";
import { resolveWebUser } from "~/lib/auth.server";
import { APP_NAME } from "~/lib/brand";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import {
  canConnectAnotherStore,
  listMemberships,
} from "~/lib/shop-access.server";
import {
  normalizeShopDomain,
  serializePendingStoreCookie,
} from "~/lib/store-link.server";
import { requestIsSecure, requestOriginIsSelf } from "~/lib/web-session.server";

export const meta = () => [{ title: `Connect your store — ${APP_NAME}` }];

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await resolveWebUser(request);
  if (!user) throw redirect("/login");
  await requireRecentReauthentication(request, user);

  // Someone who already has a store here took a wrong turn, not a new install.
  const memberships = await listMemberships(user.id);

  return {
    alreadyConnected: memberships.length > 0,
    canAdd: await canConnectAnotherStore(user.id),
    name: user.name,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await resolveWebUser(request);
  if (!user) throw redirect("/login");

  if (!requestOriginIsSelf(request)) {
    return data({ error: "Your session expired. Try again." }, { status: 403 });
  }
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "connect-shop",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 20,
    subject: user.id,
    subjectLimit: 10,
  });
  if (limited) {
    return data(
      { error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  if (!(await canConnectAnotherStore(user.id))) {
    return data(
      {
        error:
          "Adding another store requires Scale on one of your connected stores.",
      },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const domain = normalizeShopDomain(String(form.get("shop") ?? ""));

  if (!domain) {
    return data(
      { error: "Enter your myshopify.com address, like acme.myshopify.com." },
      { status: 400 },
    );
  }

  /*
   * Hand off to Shopify's own install flow, remembering which store was asked
   * for. The membership is written on the way back, and only if Shopify
   * authenticates this same domain — see `store-link.server.ts` for why the
   * cookie is not a credential.
   */
  return redirect(`/auth/login?shop=${encodeURIComponent(domain)}`, {
    headers: {
      "set-cookie": serializePendingStoreCookie(
        domain,
        requestIsSecure(request),
      ),
    },
  });
}

export default function Connect() {
  const { alreadyConnected, canAdd } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountShell
      title="Connect your Shopify store"
      tagline={
        alreadyConnected
          ? "Add another store to this account."
          : `${APP_NAME} reads your orders, products and fulfilments to work out what you kept. It never writes to your store.`
      }
    >
      <Form method="post" className="account-form">
        <Field
          label="Store address"
          name="shop"
          type="text"
          autoComplete="off"
          hint="acme.myshopify.com"
        />
        <FormError message={actionData?.error ?? null} />
        <button type="submit" className="account-submit" disabled={!canAdd}>
          Continue to Shopify
        </button>
      </Form>

      <p className="account-fineprint">
        {canAdd
          ? "Shopify will ask you to approve read-only access. Your plan and billing stay with Shopify — MyMeridian never sees a card number."
          : "Multi-store portfolio access is included on Scale. Upgrade one connected store before adding another."}
      </p>
    </AccountShell>
  );
}
