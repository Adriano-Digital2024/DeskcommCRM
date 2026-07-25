/**
 * POST /api/v1/leads/[id]/reactivation
 *
 * O humano decide sobre a proposta de reativação: `accept` ou `dismiss`. Os
 * DOIS geram atividade — recusa é sinal, não ausência de sinal. "Vi e decidi
 * não retomar" é o que distingue um negócio encerrado com critério de um
 * negócio esquecido, e sem registro os dois ficam idênticos na timeline.
 *
 * ⚠️ A TRAVA COMPARA A IDENTIDADE DA PROPOSTA (`proposal_id`), não o estado do
 * lead. Entre o render e o clique a proposta pode ter VENCIDO — e aceitar uma
 * proposta vencida executaria, em nome de quem clicou, uma decisão que o
 * sistema já registrou como não tomada. O `eq("status", "pending")` no UPDATE é
 * o que fecha a corrida no banco: quem perder recebe 409 e vê a tela atualizada.
 *
 * Mesmo raciocínio da wave 4, um degrau adiante: lá a trava era contra o agente
 * reescrever a proposta; aqui é contra o RELÓGIO tê-la encerrado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  decision: z.enum(["accept", "dismiss"]),
  /** QUAL proposta estava na tela. Ver o ⚠️ do cabeçalho. */
  proposal_id: z.string().uuid(),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const guard = await requireRole("agent", { requestId });
  if (!guard.ok) return guard.response;
  const orgId = guard.org.orgId;
  const userId = guard.user.id;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", "decision e proposal_id são obrigatórios.", 400, { requestId });
  }
  const { decision, proposal_id } = parsed.data;

  const supabase = await createClient();

  // O UPDATE condicional É a trava: `status = 'pending'` no WHERE. Ler-e-depois-
  // escrever deixaria a janela em que o watcher vence a proposta no meio.
  const { data: decidida, error } = await supabase
    .from("crm_lead_reactivations")
    .update({
      status: decision === "accept" ? "accepted" : "dismissed",
      decided_at: new Date().toISOString(),
      decided_by_user_id: userId,
    })
    .eq("id", proposal_id)
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .eq("status", "pending")
    .select("id, expires_at")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!decidida) {
    // Não distinguimos "não existe" de "já não está pendente" na MENSAGEM por
    // vazamento? Não: aqui distinguir ajuda e não expõe nada — a pessoa precisa
    // saber que a proposta venceu, senão ela clica de novo achando que falhou.
    const { data: existe } = await supabase
      .from("crm_lead_reactivations")
      .select("status")
      .eq("id", proposal_id)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (existe) {
      return fail(
        "reactivation_not_pending",
        `Esta sugestão já foi ${
          (existe as { status: string }).status === "expired" ? "encerrada pelo prazo" : "decidida"
        }.`,
        409,
        { requestId },
      );
    }
    return fail("not_found", "Sugestão não encontrada.", 404, { requestId });
  }

  const { data: lead } = await supabase
    .from("crm_leads")
    .select("contact_id")
    .eq("id", leadId)
    .maybeSingle();

  const atividade = await emitLeadActivity(supabase, {
    organizationId: orgId,
    leadId,
    contactId: (lead as { contact_id: string | null } | null)?.contact_id ?? null,
    type: decision === "accept" ? "reactivation_accepted" : "reactivation_dismissed",
    sourceModule: "crm",
    sourceId: leadId,
    actor: { type: "user", id: userId },
    // Nomeia a decisão, nunca o conteúdo da proposta nem dado do negócio.
    reason:
      decision === "accept"
        ? "Retomada de contato aprovada"
        : "Retomada de contato descartada — decisão registrada",
    payload: { proposal_id },
  });
  if (!atividade.ok) {
    // ALTO: esta atividade É O REGISTRO DA DECISÃO, não rastro de algo já
    // visível. Sem ela, o negócio volta ao normal e ninguém sabe quem mandou —
    // e a próxima proposta nasce sem saber que esta foi recusada.
    await registraFalhaDeAtividade(supabase, {
      organizationId: orgId,
      leadId,
      tipo: decision === "accept" ? "reactivation_accepted" : "reactivation_dismissed",
      origem: "api/v1/leads/[id]/reactivation",
      erro: atividade.error,
      requestId,
    });
    return fail(
      "activity_write_failed",
      "A decisão não pôde ser registrada. Nada foi enviado ao cliente.",
      500,
      { requestId },
    );
  }

  return ok(
    {
      id: (decidida as { id: string }).id,
      status: decision === "accept" ? "accepted" : "dismissed",
      // O ENVIO é do motor de follow-up, não desta rota — ver o cabeçalho de
      // `lib/leads/reactivation.ts`. Aqui fica a DECISÃO.
      envio_agendado: decision === "accept",
    },
    { requestId },
  );
}
