"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fmt } from "@/lib/catalog";

type Row = { id: string; email: string; status: string; created_at: string; gross_cents: number; upsell_cents: number | null };

export default function Admin() {
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { try { setToken(sessionStorage.getItem("adminToken") ?? ""); } catch {} }, []);

  async function load(t = token, clearMsg = true) {
    const res = await fetch("/api/admin/orders", { headers: { authorization: `Bearer ${t}` }, cache: "no-store" });
    if (!res.ok) { setRows(null); setMsg({ kind: "err", text: res.status === 401 ? "Wrong admin token" : "Failed to load" }); return; }
    try { sessionStorage.setItem("adminToken", t); } catch {}
    if (clearMsg) setMsg(null);
    setRows((await res.json()).orders);
  }

  async function refund(id: string) {
    setBusy(id);
    const res = await fetch(`/api/admin/orders/${id}/refund-upsell`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    setMsg(res.ok
      ? { kind: "ok", text: data.alreadyRefunded ? `Already refunded (${data.refundId}). No second refund was issued.` : `Refunded upsell: ${data.refundId} (${data.status})` }
      : { kind: "err", text: data.error });
    setBusy(null);
    load(token, false); // refresh the table but keep the refund confirmation visible
  }

  return (
    <div className="card">
      <h1>Admin · orders</h1>
      <p className="muted" style={{ marginTop: 0 }}>Refunds only ever touch the upsell charge. The endpoint is idempotent, so pressing twice issues one refund.</p>
      <form onSubmit={(e) => { e.preventDefault(); load(); }} style={{ display: "flex", gap: 8, margin: "14px 0" }}>
        <input type="password" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Admin token" />
        <button className="btn small">Load</button>
      </form>
      {msg && <div className={`notice ${msg.kind}`} data-testid="admin-msg" style={{ marginBottom: 12 }}>{msg.text}</div>}
      {rows && (
        <div className="scroll-x">
          <table>
            <thead><tr><th>Order</th><th>Email</th><th>Status</th><th>Gross</th><th>Upsell</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`admin-row-${r.id}`}>
                  <td><Link href={`/orders/${r.id}`} className="mono">{r.id.slice(0, 8)}</Link></td>
                  <td>{r.email}</td>
                  <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                  <td>{fmt(r.gross_cents)}</td>
                  <td>{r.upsell_cents ? fmt(r.upsell_cents) : "·"}</td>
                  <td>
                    {(r.status === "upsell_paid" || r.status === "refunded") && (
                      <button className="btn small" disabled={busy === r.id} onClick={() => refund(r.id)} data-testid="refund-upsell">
                        {r.status === "refunded" ? "Refund again (no-op)" : "Refund upsell"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
