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
          profit number. A Shopify order also carries the customer who placed
          it, so this scope — and not any customer scope — is how the two
          shopper fields listed under <em>Personal data specifically</em> below
          reach {APP_NAME}.
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
        <code>read_customers</code> and <code>read_all_orders</code> are{" "}
        <strong>not</strong> requested. Because <code>read_all_orders</code> is
        not held, Shopify returns only the last 60 days of order history, and
        the app says so on screen rather than presenting a short history as a
        complete one.
      </p>

      <h2>Personal data specifically</h2>
      <p>
        Shopper personal data does reach {APP_NAME}, through{" "}
        <code>read_orders</code>. Exactly two shopper fields are read from
        Shopify and stored:
      </p>
      <ul>
        <li>
          the <strong>Shopify customer id</strong> carried on the order — the
          identifier that links a store&rsquo;s repeat orders to one person, so
          that lifetime value and acquisition cost can be computed at all; and
        </li>
        <li>
          the <strong>email address</strong> on that customer record. It is
          stored so that a <code>customers/data_request</code> or{" "}
          <code>customers/redact</code> naming a shopper can be matched to the
          right rows and answered, and it is included in the export handed to
          the merchant for a data request.
        </li>
      </ul>
      <p>
        Nothing else about a shopper is read or stored. {APP_NAME} holds no
        shopper <strong>name</strong>, <strong>phone number</strong>,{" "}
        <strong>billing or shipping address</strong> or{" "}
        <strong>IP address</strong>, and it does not read, request or store
        payment card details or passwords. It requests no scope that would
        expose them.
      </p>
      <p>
        Derived from those two fields and the orders themselves, {APP_NAME}{" "}
        stores per customer: the date of their first order, the channel and
        campaign that acquired them, their order count, and their lifetime
        revenue and profit. Per order it stores the order number, its
        timestamps, currency, the money totals above, financial and fulfilment
        status, the marketing channel, any UTM parameters, and the landing page
        URL of the visit the order is attributed to. The referring URL is read
        to classify that channel but is not itself stored. Line items are stored
        as title, SKU, quantity and unit price.
      </p>
      <p>
        Because a shopper email address is among the fields read and stored,
        {APP_NAME}&rsquo;s access to orders falls under Shopify&rsquo;s
        protected customer data requirements at the level that covers customer
        email, and is subject to the approval and the data-handling
        undertakings that go with it.
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
