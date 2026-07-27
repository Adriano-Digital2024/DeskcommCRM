import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { RiskRadarList } from "./_components/RiskRadarList";

export const dynamic = "force-dynamic";

export default async function RadarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Radar de risco</h1>
        <p className="text-sm text-muted-foreground">
          Demandas abertas que esfriaram e precisam de você. Se o assistente já agendou um
          retorno, aparece como “em voo”; sem próximo passo, é risco de perder o cliente.
        </p>
      </header>
      <RiskRadarList />
    </div>
  );
}
