import { useLoaderData } from "react-router";

import { LegalContact, LegalPage } from "~/design/components";
import { APP_NAME } from "~/lib/brand";
import { contactDetails } from "~/lib/brand.server";

/**
 * Shopify's listing requires a support contact a merchant can reach without
 * installing the app, so this route is public and unauthenticated like
 * `/privacy`.
 */
export function loader() {
  return { contact: contactDetails() };
}

export const meta = () => [
  { title: `${APP_NAME} — Support` },
  {
    name: "description",
    content: `How to get help with ${APP_NAME}, and what to check first.`,
  },
];

export default function Support() {
  const { contact } = useLoaderData<typeof loader>();

  return (
    <LegalPage title="Support">
      <h2>Contact</h2>
      <LegalContact contact={contact} />

      <h2>Before you write in</h2>
      <p>
        Most questions about {APP_NAME} turn out to be one of these, and each is
        answerable from inside the app.
      </p>
      <ul>
        <li>
          <strong>Margins look too high, or every product shows 100%.</strong>{" "}
          {APP_NAME} takes cost of goods from the unit cost recorded against
          each variant&rsquo;s inventory item in Shopify. A variant with no cost
          set contributes nothing to COGS. Open <em>Products</em>: sold units
          with missing COGS are labelled <em>Needs COGS</em>, and modeled fee or
          fulfilment inputs are marked separately from measured costs.
        </li>
        <li>
          <strong>History only reaches back 60 days.</strong> MyMeridian is
          approved for <code>read_all_orders</code>, but an installation created
          before that approval may still need to grant the updated scope. Open
          <em>Costs &amp; connections</em> to see the scopes this store granted.
        </li>
        <li>
          <strong>Acquisition shows no customer acquisition cost.</strong> CAC,
          lifetime value and payback need <code>read_customers</code>, which is
          protected customer data and needs a separate approved request. The
          screen says which figures are unavailable rather than showing zeroes.
        </li>
        <li>
          <strong>Numbers disagree with Shopify&rsquo;s own reports.</strong>{" "}
          They are measuring different things. Shopify reports gross sales;{" "}
          {APP_NAME} reports what is left after cost of goods, shipping, pick
          and pack, payment fees, overhead and any paid-marketing spend that a
          connected Meta, Google or TikTok source has successfully synced. If
          no source has completed a sync, <em>Overview</em> labels the result as
          profit before paid marketing and shows ad spend as unavailable rather
          than zero. It never treats an unconnected account as zero spend.
        </li>
        <li>
          <strong>A new product shows no cost.</strong> Set{" "}
          <em>Cost per item</em> on the variant in Shopify. Inventory updates
          keep the catalog current, and each new order snapshots the cost
          available when MyMeridian ingests it; an unknown historical cost is
          never invented.
        </li>
      </ul>

      <h2>What to include in a support request</h2>
      <p>
        Your <code>.myshopify.com</code> domain, the screen you were on, the
        date range selected, and what you expected the number to be. If a figure
        looks wrong, one order id that shows the problem is worth more than a
        description of the whole dashboard.
      </p>

      <h2>Data and deletion</h2>
      <p>
        Uninstalling {APP_NAME} from your Shopify admin ends all data collection
        immediately. See the <a href="/privacy">privacy policy</a> for what is
        held, for how long, and how to request erasure.
      </p>
    </LegalPage>
  );
}
