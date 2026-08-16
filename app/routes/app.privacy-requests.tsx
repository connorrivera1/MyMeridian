import { useState } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";

import { Badge, Banner, Card, Empty } from "~/design/components";
import { withShopContext } from "~/lib/auth.server";
import {
  DATA_REQUEST_RETENTION_DAYS,
  listDataRequests,
} from "~/lib/data-request.server";

// Customer identifiers remain in the metadata list. The full report is never
// loader data, but neither representation may be retained by a browser,
// intermediary, or embedded-admin cache.
export const headers: HeadersFunction = () => ({
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
});

/**
 * Privacy obligations survive subscription cancellation. Authentication and
 * shop scoping still apply, but this route deliberately has no plan gate.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, async ({ shop }) => {
    const requestedPage = Number.parseInt(
      new URL(request.url).searchParams.get("historyPage") ?? "1",
      10,
    );

    return {
      requests: await listDataRequests(shop.id, {
        historyPage: Number.isSafeInteger(requestedPage) ? requestedPage : 1,
      }),
      timezone: shop.timezone,
      retentionDays: DATA_REQUEST_RETENTION_DAYS,
    };
  });
}

type LoadedDataRequest = Awaited<
  ReturnType<typeof loader>
>["requests"]["outstanding"][number];

export default function PrivacyRequests() {
  const data = useLoaderData<typeof loader>();
  const { outstanding, history } = data.requests;
  const empty = outstanding.length === 0 && data.requests.collectedTotal === 0;

  return (
    <Card
      title="Customer Data Requests"
      hint={`When a shopper asks what your store holds on them, Shopify sends the request here and Meridian assembles the export for you to hand over. You are the controller and reply to the shopper; Meridian never contacts them. Exports expire ${data.retentionDays} days after the request and are removed by the hourly privacy sweep. This page remains available even without an active subscription.`}
      flush
    >
      {outstanding.length > 0 && (
        <div style={{ padding: "14px 16px 0" }}>
          <Banner tone="warn">
            {outstanding.length.toLocaleString()} export
            {outstanding.length === 1 ? " is" : "s are"} awaiting collection.
            Every active obligation is shown below; none are hidden by the
            collected-history page size.
          </Banner>
        </div>
      )}

      {empty ? (
        <div style={{ padding: "14px 16px" }}>
          <Empty>
            No requests. One appears here within seconds of a shopper asking
            through Shopify.
          </Empty>
        </div>
      ) : (
        <>
          {outstanding.length > 0 && (
            <RequestTable
              label="Awaiting Collection"
              requests={outstanding}
              timeZone={data.timezone}
            />
          )}
          {data.requests.collectedTotal > 0 && (
            <>
              <RequestTable
                label="Collected History"
                requests={history}
                timeZone={data.timezone}
              />
              <HistoryPagination
                page={data.requests.historyPage}
                pageCount={data.requests.historyPageCount}
                total={data.requests.collectedTotal}
              />
            </>
          )}
        </>
      )}
    </Card>
  );
}

function RequestTable({
  label,
  requests,
  timeZone,
}: {
  label: string;
  requests: LoadedDataRequest[];
  timeZone: string;
}) {
  return (
    <section aria-label={label}>
      <div
        className="tiny muted"
        style={{ padding: "16px 16px 8px", textTransform: "uppercase" }}
      >
        {label}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Requested</th>
              <th>Contents</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <DataRequestRow
                key={request.id}
                request={request}
                timeZone={timeZone}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoryPagination({
  page,
  pageCount,
  total,
}: {
  page: number;
  pageCount: number;
  total: number;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Collected Request History"
      style={{
        alignItems: "center",
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        padding: "12px 16px 16px",
      }}
    >
      {page > 1 && (
        <Link className="btn sm" to={`?historyPage=${page - 1}`}>
          Previous
        </Link>
      )}
      <span className="tiny muted">
        Page {page.toLocaleString()} Of {pageCount.toLocaleString()} ·{" "}
        {total.toLocaleString()} Collected
      </span>
      {page < pageCount && (
        <Link className="btn sm" to={`?historyPage=${page + 1}`}>
          Next
        </Link>
      )}
    </nav>
  );
}

function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition");
  const match = disposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? fallback;
}

/** The report crosses the browser boundary only after this explicit click. */
function DataRequestRow({
  request,
  timeZone,
}: {
  request: LoadedDataRequest;
  timeZone: string;
}) {
  const revalidator = useRevalidator();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedAt = new Date(request.requestedAt);
  const expiresAt = new Date(request.expiresAt);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      // App Bridge injects the session-token Authorization header into global
      // fetch on real stores. Demo mode uses the same-origin authenticated
      // boundary selected by requireShopContext.
      const response = await fetch(
        `/app/privacy-requests/${encodeURIComponent(request.id)}/download`,
        { method: "POST", headers: { Accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "This export has expired or was removed."
            : "The export could not be downloaded.",
        );
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = responseFilename(
        response,
        `meridian-data-request-${requestedAt.toISOString().slice(0, 10)}.json`,
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      revalidator.revalidate();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The export could not be downloaded.",
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <tr>
      <td className="primary-cell">
        {request.customerEmail ?? "Email not held"}
        <div className="cell-sub">
          <code>{request.shopifyCustomerId}</code>
        </div>
      </td>
      <td className="tiny muted">
        {requestedAt.toLocaleString("en-US", {
          timeZone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
        <div className="cell-sub">
          deleted{" "}
          {expiresAt.toLocaleDateString("en-US", {
            timeZone,
            month: "short",
            day: "numeric",
          })}
        </div>
      </td>
      <td className="secondary tiny">
        {request.ordersIncluded > 0
          ? `${request.ordersIncluded} order${request.ordersIncluded === 1 ? "" : "s"}, with line items`
          : "Nothing held on this shopper"}
      </td>
      <td>
        {request.collectedAt ? (
          <Badge tone="good">Collected</Badge>
        ) : (
          <Badge tone="warning">Awaiting Collection</Badge>
        )}
        {error && <div className="cell-sub">{error}</div>}
      </td>
      <td>
        <button
          className="btn sm"
          type="button"
          disabled={downloading}
          onClick={() => void download()}
        >
          {downloading ? "Preparing…" : "Download JSON"}
        </button>
      </td>
    </tr>
  );
}
