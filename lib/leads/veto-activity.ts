import type pg from "pg";

import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

export interface VetoActivityInput {
  pool: pg.Pool;
  organizationId: string;
  /** No harness, "lead" é o CONTATO (inbound-turn: leadId = job.contact_id). */
  contactId: string;
  /** `before_send_traces.id` — o lastro desta decisão. */
  traceId: string;
  gate: string;
  code: string;
  agentId?: string | null;
}

/**
 * O agente decidiu NÃO falar — e isso vira linha na timeline.
 *
 * É o evento mais contra-intuitivo da entrega: o silêncio da IA com motivo é
 * informação (o humano vê que houve decisão e por quê); o silêncio sem registro
 * é abandono disfarçado de calmaria. Cenário 11 do §7.
 *
 * Roda no motor do agente, fora do request: escreve pelo `pg.Pool`, mas a linha
 * é montada pela MESMA regra da API (`buildLeadActivityRow`).
 *
 * Nunca lança: um veto registrado com sucesso não pode falhar por causa da
 * timeline dele.
 */
export async function emitVetoActivity(
  input: VetoActivityInput,
): Promise<{ routed: boolean; reason?: string }> {
  const { pool, organizationId, contactId } = input;

  const { rows } = await pool.query<LeadCandidate>(
    `select l.id, l.organization_id, l.pipeline_id, l.status,
            l.last_activity_at, l.created_at
       from crm_leads l
      where l.organization_id = $1 and l.contact_id = $2`,
    [organizationId, contactId],
  );

  const { rows: defaults } = await pool.query<{ id: string }>(
    `select id from crm_pipelines
      where organization_id = $1 and is_default = true and is_archived = false
      limit 1`,
    [organizationId],
  );

  const alvo = resolveActiveLeadForContact(rows, { defaultPipelineId: defaults[0]?.id ?? null });

  if (!alvo.routed) {
    // NÃO adivinha o negócio: `crm_lead_activities.lead_id` é not null, então
    // "atividade órfã" não existe — o registro vai para o event_log, onde é
    // barulho auditável em vez de dano no card errado (§3.2).
    await pool.query(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata)
       values ($1, 'agent.activity_unrouted', 'contact', $2, $3, $4)`,
      [
        organizationId,
        contactId,
        JSON.stringify({
          reason: alvo.reason,
          candidate_lead_ids: alvo.candidateIds,
          activity_type: "send_vetoed",
        }),
        JSON.stringify({ trace_id: input.traceId, gate: input.gate, code: input.code }),
      ],
    );
    return { routed: false, reason: alvo.reason };
  }

  const row = buildLeadActivityRow({
    organizationId,
    leadId: alvo.leadId,
    contactId,
    type: "send_vetoed",
    // O QUE ORIGINOU: a linha de auditoria do gate. O lastro (evidence) é a
    // mesma trace — aqui origem e prova coincidem por natureza, e por isso
    // `source_id` fica com o ponteiro e `evidence` com a referência.
    sourceModule: "agent_guardrails",
    sourceId: input.traceId,
    actor: input.agentId
      ? { type: "ai_agent", id: input.agentId, role: "agent" }
      : { type: "webhook_source", id: "agent_guardrails" },
    reason: vetoReason(input.gate, input.code),
    evidence: { trace_ids: [input.traceId] },
    payload: { gate: input.gate, code: input.code },
  });

  await pool.query(
    `insert into crm_lead_activities
       (organization_id, lead_id, contact_id, type, source_module, source_id,
        actor_kind, actor_agent_id, performed_by_user_id, reason, evidence, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.organization_id,
      row.lead_id,
      row.contact_id,
      row.type,
      row.source_module,
      row.source_id,
      row.actor_kind,
      row.actor_agent_id,
      row.performed_by_user_id,
      row.reason,
      row.evidence ? JSON.stringify(row.evidence) : null,
      JSON.stringify(row.payload),
    ],
  );

  return { routed: true };
}

/** Motivo legível — o humano lê "não enviei porque", não um código de gate. */
export function vetoReason(gate: string, code: string): string {
  const porGate: Record<string, string> = {
    stop: "Não enviei: o contato pediu para parar de receber mensagens",
    window: "Não enviei: fora da janela de horário permitida",
    pacing: "Não enviei: limite de ritmo de envio atingido",
    budget: "Não enviei: orçamento de IA esgotado",
    warmup: "Não enviei: número ainda em aquecimento",
    promise: "Não enviei: a mensagem prometia algo que não posso garantir",
  };
  return porGate[gate] ?? `Não enviei: bloqueado pela regra "${gate}" (${code})`;
}
