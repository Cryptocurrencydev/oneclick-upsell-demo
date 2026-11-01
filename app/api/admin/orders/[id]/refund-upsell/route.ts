import { refundUpsell } from "@/lib/refunds";
import { isAdmin } from "@/lib/admin";
import { json, errorResponse } from "@/lib/http";

export async function POST(req: Request, ctx: RouteContext<"/api/admin/orders/[id]/refund-upsell">) {
  if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not found" }, 404);
    const r = await refundUpsell(id);
    return r.ok ? json(r) : json({ error: r.error }, r.status);
  } catch (e) {
    return errorResponse(e);
  }
}
