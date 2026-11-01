import { abandonUpsell } from "@/lib/upsell";
import { json, errorResponse } from "@/lib/http";

export async function POST(_req: Request, ctx: RouteContext<"/api/orders/[id]/upsell/abandon">) {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not found" }, 404);
    return json(await abandonUpsell(id));
  } catch (e) {
    return errorResponse(e);
  }
}
