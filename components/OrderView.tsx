"use client";
import { fmt } from "@/lib/catalog";
import { useOrder, type OrderViewData } from "./useOrder";

const settled = (v: OrderViewData | null) =>
  !v || v.order.status === "pending" || v.order.status === "upsell_pending";

export default function OrderView({ orderId }: { orderId: string }) {
  const { view, error } = useOrder(orderId, settled);
  if (error) return <div className="card"><div className="notice err">{error}</div></div>;
  if (!view) return <div className="card"><span className="spinner" />Loading order…</div>;
  const { order } = view;

  return (
    <div className="grid">
      <section className="card" data-testid="confirmation">
        <h1>Order confirmed</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          #{order.id.slice(0, 8)} · {order.email} · <span className={`pill ${order.status}`} data-testid="order-status">{order.status}</span>
        </p>
        <div style={{ marginTop: 16 }}>
          {view.lineItems.map((li) => (
            <div className="row" key={li.kind} data-testid={`line-${li.kind}`}>
              <span>
                {li.name}
                {li.kind === "upsell" && <span className="muted"> · one-click add-on</span>}
                {li.refunded && <> <span className="pill refunded">refunded</span></>}
              </span>
              <span style={li.refunded ? { textDecoration: "line-through" } : undefined}>{fmt(li.amount_cents)}</span>
            </div>
          ))}
          <div className="row total"><span>Total charged</span><span data-testid="order-total">{fmt(view.total)}</span></div>
        </div>
        {order.status === "upsell_pending" && <div className="notice warn" style={{ marginTop: 12 }}>Add-on payment still confirming…</div>}
      </section>

      <section className="card">
        <h2>Audit trail</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Every state transition, as logged in <span className="mono">order_events</span>.</p>
        <ul className="timeline" data-testid="timeline">
          {view.events.map((e, i) => (
            <li key={i}>
              <time>{new Date(e.created_at).toLocaleTimeString()}</time>
              <span className={`pill ${e.to_status}`}>{e.from_status ?? "∅"} → {e.to_status}</span>
              <span className="muted">via {e.source}</span>
              <span style={{ flexBasis: "100%", fontSize: 12 }} className="mono">{e.reason}</span>
            </li>
          ))}
        </ul>
        <h2 style={{ marginTop: 18 }}>Charges</h2>
        <div className="scroll-x">
          <table>
            <thead><tr><th>Step</th><th>Try</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {view.charges.map((c) => (
                <tr key={c.id}><td>{c.step}</td><td>{c.attempt}</td><td><span className={`pill ${c.status}`}>{c.status}</span>{c.failure_code && <span className="muted"> {c.failure_code}</span>}</td><td>{fmt(c.amount_cents)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
