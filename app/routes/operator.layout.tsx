import { Form, Link, Outlet } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";

import operatorStyles from "~/design/operator.css?url";
import {
  OPERATOR_SECURITY_HEADERS,
  requireOperator,
} from "~/lib/operator-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOperator(request, "metrics:read", {
    action: "OPERATOR_SHELL_VIEW",
    resource: "operator_navigation",
  });
  return { role: "Publisher" };
}

export const links = () => [{ rel: "stylesheet", href: operatorStyles }];
export const headers: HeadersFunction = () => OPERATOR_SECURITY_HEADERS;

export default function OperatorLayout() {
  return (
    <div className="operator-shell">
      <header className="operator-header">
        <Link to="/operator" className="operator-brand">
          <span className="operator-brand-mark" aria-hidden="true">M</span>
          <span>
            <strong>Meridian operations</strong>
            <small>Publisher only</small>
          </span>
        </Link>
        <nav aria-label="Operator navigation">
          <Link to="/operator">Business &amp; health</Link>
          <Form method="post" action="/operator/logout">
            <button type="submit" className="operator-link-button">Sign out</button>
          </Form>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
