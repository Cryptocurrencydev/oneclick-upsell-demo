import { timingSafeEqual } from "node:crypto";

export function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 16) return false; // admin disabled unless a strong token is configured
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
