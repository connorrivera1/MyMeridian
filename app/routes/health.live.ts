export async function loader() {
  return Response.json(
    { status: "ok", service: "mymeridian" },
    { headers: { "cache-control": "no-store" } },
  );
}
