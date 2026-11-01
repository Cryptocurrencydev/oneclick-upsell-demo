export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function errorResponse(e: unknown) {
  const name = (e as Error)?.constructor?.name;
  if (name === "NotFound") return json({ error: "not found" }, 404);
  if (name === "BadRequest") return json({ error: (e as Error).message }, 400);
  console.error("[api]", e);
  return json({ error: "internal error" }, 500);
}
