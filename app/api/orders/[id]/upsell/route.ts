import { chargeUpsell } from "@/lib/upsell";
import { json, errorResponse } from "@/lib/http";

export const maxDuration = 30;

export async function POST(_req: Request, ctx: RouteContext<"/api/orders/[id]/upsell">) {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not found" }, 404);
    return json(await chargeUpsell(id));
  } catch (e) {
    return errorResponse(e);
  }
}
