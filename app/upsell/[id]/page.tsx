import { Suspense } from "react";
import Upsell from "@/components/Upsell";

export default function Page({ params }: PageProps<"/upsell/[id]">) {
  return (
    <Suspense fallback={<div className="card"><span className="spinner" />Loading…</div>}>
      <Inner params={params} />
    </Suspense>
  );
}

async function Inner({ params }: { params: PageProps<"/upsell/[id]">["params"] }) {
  const { id } = await params;
  return <Upsell orderId={id} />;
}
