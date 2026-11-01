import { startCheckout } from "@/lib/checkout";
import { json, errorResponse } from "@/lib/http";

export async function POST(req: Request) {
  try {
    const { checkoutRef, email } = await req.json();
    return json(await startCheckout(String(checkoutRef ?? ""), String(email ?? "")));
  } catch (e) {
    return errorResponse(e);
  }
}
