import Checkout from "@/components/Checkout";
import { MAIN_PRODUCT, fmt } from "@/lib/catalog";

export default function Page() {
  return (
    <div className="grid">
      <section className="card">
        <h1>Your order</h1>
        <div className="product" style={{ margin: "18px 0" }}>
          <div className="swatch" aria-hidden />
          <div>
            <strong>{MAIN_PRODUCT.name}</strong>
            <div className="muted">Smoked low and slow over applewood. Notes of campfire, honey and stone fruit.</div>
          </div>
        </div>
        <div className="row"><span>Subtotal</span><span>{fmt(MAIN_PRODUCT.amount_cents)}</span></div>
        <div className="row"><span>Shipping</span><span>Free</span></div>
        <div className="row total"><span>Total</span><span>{fmt(MAIN_PRODUCT.amount_cents)}</span></div>
        <div className="notice warn" style={{ marginTop: 14 }}>
          Test cards: <span className="mono">4242 4242 4242 4242</span> (success) ·{" "}
          <span className="mono">4000 0000 0000 0002</span> (decline) ·{" "}
          <span className="mono">4000 0027 6000 3184</span> (3DS). Any future date and CVC.
        </div>
      </section>
      <Checkout />
    </div>
  );
}
