import { addSecurityHeaders } from "~/lib/http-security";

export async function loader() {
  const headers = new Headers({ "cache-control": "no-store" });
  addSecurityHeaders(headers);
  return Response.json(
    { status: "ok", service: "mymeridian" },
    { headers },
  );
}
