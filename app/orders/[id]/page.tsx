import { Suspense } from "react";
import OrderView from "@/components/OrderView";

export default function Page({ params }: PageProps<"/orders/[id]">) {
  return (
    <Suspense fallback={<div className="card"><span className="spinner" />Loading…</div>}>
      <Inner params={params} />
    </Suspense>
  );
}

async function Inner({ params }: { params: PageProps<"/orders/[id]">["params"] }) {
  const { id } = await params;
  return <OrderView orderId={id} />;
}
