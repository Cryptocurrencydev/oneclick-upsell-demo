import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { BRAND } from "@/lib/catalog";

export const metadata: Metadata = {
  title: `${BRAND.name}: one-click upsell demo`,
  description: "Demo checkout with a post-purchase one-click upsell. Stripe test mode only.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              {BRAND.name}
              <small>{BRAND.tagline}</small>
            </Link>
            <span className="badge">Demo · Stripe TEST mode · no real charges</span>
          </header>
          {children}
          <footer className="foot">
            Fictional brand · Demo by DC Tech · Built with Claude Code. Test cards only: 4242 4242 4242 4242 · <Link href="/admin">admin</Link>
          </footer>
        </div>
      </body>
    </html>
  );
}
