// Fictional brand. Prices are server-side only; the client never sends an amount.
export const BRAND = { name: "Fernhollow Tea Co.", tagline: "Small-batch teas, smoked over applewood." };

export const MAIN_PRODUCT = {
  sku: "FH-EMBER-100",
  name: "Ember Ridge Smoked Oolong · 100g tin",
  amount_cents: 2800,
};

export const UPSELL_PRODUCT = {
  sku: "FH-PEONY-50",
  name: "Moonmilk White Peony · 50g tin",
  amount_cents: 1400,
  pitch: "Add a tin of Moonmilk White Peony for $14. It ships in the same box, and there's nothing to re-enter.",
};

export const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
