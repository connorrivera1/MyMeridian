import { useLoaderData } from "react-router";

import { LegalContact, LegalPage } from "~/design/components";
import { APP_NAME, PRIVACY_UPDATED } from "~/lib/brand";
import { contactDetails } from "~/lib/brand.server";

/**
 * Shopify requires a publicly reachable privacy policy URL on the listing, and
 * the reviewer opens it unauthenticated. This route therefore has no auth of
 * any kind and must never gain one.
 *
 * The contents describe what the code actually does — the scopes in
 * `shopify.app.toml`, the tables in `prisma/schema.prisma`, and the three
 * compliance webhooks in `app/routes/webhooks.gdpr.*`. If any of those change,
 * this changes with them.
 */
export function loader() {
  return { contact: contactDetails() };
}

export const meta = () => [
  { title: `${APP_NAME} — Privacy policy` },
  {
    name: "description",
    content: `How ${APP_NAME} collects, uses, stores and deletes Shopify store data.`,
  },
];

export default function Privacy() {
  const { contact } = useLoaderData<typeof loader>();

  return (
    <LegalPage title="Privacy policy" updated={PRIVACY_UPDATED}>
      <p>
        {APP_NAME} is a profitability dashboard for Shopify stores. It reads a
        store&rsquo;s order, product, inventory and fulfilment records, combines
        them with cost figures the merchant enters, and reports what each order
        and product actually earned. This policy describes every category of
        data it touches and what happens to it.
      </p>

      <h2>Who this policy is for</h2>
      <p>
        The merchant who installs {APP_NAME} is our customer. Their store&rsquo;s
        shoppers are not — we hold shopper data only as a processor acting on
        the merchant&rsquo;s instructions, and the merchant remains the
        controller of it.
      </p>

      <h2>What we read from Shopify</h2>
      <p>
        {APP_NAME} requests these access scopes at install, and no others. Each
        is requested because a specific figure cannot be computed without it.
      </p>
      <ul>
        <li>
          <code>read_orders</code> — order totals, discounts, taxes, shipping
          charged, line items and refunds. This is the revenue side of every
          profit number.
        </li>
        <li>
          <code>read_products</code> — products and variants, so line items can
          be grouped by what was actually sold.
        </li>
        <li>
          <code>read_inventory</code> — the per-variant unit cost recorded on
          the inventory item. Without it, cost of goods is zero and every margin
          would be overstated.
        </li>
        <li>
          <code>read_fulfillments</code> — when each order shipped, used for
          fulfilment capacity and shipping cost.
        </li>
      </ul>
      <p>
        {APP_NAME} requests <strong>no write scope</strong>. It cannot change a
        price, an order, or anything else in the store. Accepted pricing
        recommendations are recorded inside {APP_NAME} only; applying them
        remains a manual action the merchant takes in Shopify.
      </p>
      <p>
        Some stores additionally approve <code>read_customers</code> or{" "}
        <code>read_all_orders</code> through Shopify&rsquo;s protected customer
        data process. Where they are granted, {APP_NAME} stores a customer
        identifier, first-order date and acquisition channel in order to compute
        customer acquisition cost and lifetime value. Where they are not
        granted, those screens say so rather than showing zeroes.
      </p>

      <h2>Personal data specifically</h2>
      <p>
        {APP_NAME} does not read, request or store payment card details,
        passwords, or shopper contact details. Where <code>read_customers</code>{" "}
        is granted, the customer records held are limited to a Shopify customer
        id, the date of their first order, and the channel that acquired them.
      </p>

      <h2>What the merchant gives us directly</h2>
      <p>
        Cost inputs entered in <em>Costs &amp; connections</em> — payment
        processing rates, shipping and pick-and-pack estimates, and fixed
        monthly overhead. Where a merchant connects an advertising account, the
        access token for that account is encrypted at rest with AES-256-GCM
        before it is stored, and only ad spend figures are read back.
      </p>

      <h2>How data is stored and secured</h2>
      <ul>
        <li>
          Data is held in a PostgreSQL database, isolated per store, and reached
          only over TLS.
        </li>
        <li>
          Shopify session tokens are stored server-side and are never exposed to
          the browser.
        </li>
        <li>
          Third-party OAuth tokens are encrypted at rest under a key held
          outside the database.
        </li>
        <li>
          Every webhook Shopify sends is HMAC-verified before it is acted on; an
          unverified request is rejected with 401 and nothing is written.
        </li>
      </ul>

      <h2>Who else sees it</h2>
      <p>
        {APP_NAME} does not sell store data, does not share it with advertisers,
        and does not use it to train models. It is disclosed only to the
        infrastructure providers needed to run the service — the database and
        application host — and to Shopify itself. Where a merchant connects an
        advertising platform, {APP_NAME} reads spend from that platform; it does
        not send store data to it.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Store data is retained while the app is installed. On uninstall the
        store&rsquo;s sessions are deleted immediately, and the remaining records
        are removed when Shopify sends <code>shop/redact</code>.
      </p>

      <h2>Requests to access or erase data</h2>
      <p>
        {APP_NAME} implements all three of Shopify&rsquo;s mandatory compliance
        webhooks, and acts on each automatically:
      </p>
      <ul>
        <li>
          <code>customers/data_request</code> — everything held about the named
          customer is assembled into an export and made available to the
          merchant, who is the controller and responds to the shopper. The
          merchant collects it from Settings; it is deleted 31 days after the
          request whether or not they do.
        </li>
        <li>
          <code>customers/redact</code> — the customer record is deleted and
          their orders anonymised in place. The orders are kept without any
          identifier, because deleting them outright would silently rewrite the
          merchant&rsquo;s own historical revenue.
        </li>
        <li>
          <code>shop/redact</code> — every record belonging to that store is
          deleted, including sessions, orders, products, cost rules and
          connectors.
        </li>
      </ul>
      <p>
        A merchant may also request access or erasure directly using the contact
        details below, without going through Shopify.
      </p>

      <h2>International transfers and legal basis</h2>
      <p>
        Data is processed on infrastructure that may be located outside the
        merchant&rsquo;s country. Processing is carried out to perform the
        contract with the merchant, and on their instruction in respect of any
        shopper data.
      </p>

      <h2>Changes</h2>
      <p>
        Material changes to this policy are announced in the app before they
        take effect. The date at the top is the last substantive revision.
      </p>

      <h2>Contact</h2>
      <LegalContact contact={contact} />
    </LegalPage>
  );
}
