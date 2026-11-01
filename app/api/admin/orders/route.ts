import { pool } from "@/lib/db";
import { isAdmin } from "@/lib/admin";
import { json } from "@/lib/http";

export async function GET(req: Request) {
  if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
  const { rows } = await pool().query(
    `select o.id, o.email, o.status, o.created_at,
       coalesce(sum(li.amount_cents),0)::int as gross_cents,
       max(case when li.kind='upsell' then li.amount_cents end) as upsell_cents
     from orders o left join line_items li on li.order_id = o.id
     group by o.id order by o.created_at desc limit 50`,
  );
  return json({ orders: rows });
}
