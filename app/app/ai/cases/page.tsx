import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CaseList } from "./_components/CaseList";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // GET/POST de /api/v1/ai/cases exigem role agent+ (requireRole("agent")) —
  // abaixo disso a rota nem devolve dado, então a tela inteira gate aqui.
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.agent) redirect("/app");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Casos</h1>
        <p className="text-sm text-muted-foreground">
          Quando a IA trava em algo que só um humano resolve, ela abre um caso aqui — e
          continua conversando com o cliente enquanto espera sua resposta.
        </p>
      </header>
      <CaseList />
    </div>
  );
}
