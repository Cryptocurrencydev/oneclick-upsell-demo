import { getOrderView, reconcileOrder } from "@/lib/orders";
import { json, errorResponse } from "@/lib/http";

export async function GET(_req: Request, ctx: RouteContext<"/api/orders/[id]">) {
  try {
    const { id } = await ctx.params;
    let view = await getOrderView(id);
    if (!view) return json({ error: "not found" }, 404);
    if (view.charges.some((c) => c.status === "creating" || c.status === "processing")) {
      await reconcileOrder(id); // only touches charges stuck > 5s; webhooks normally win
      view = await getOrderView(id);
    }
    return json(view);
  } catch (e) {
    return errorResponse(e);
  }
}
