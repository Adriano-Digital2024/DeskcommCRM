import type { LeadStatus } from "@/lib/types/leads";

/** O mínimo para decidir qual negócio da pessoa está em jogo agora. */
export interface LeadCandidate {
  id: string;
  pipeline_id: string;
  status: LeadStatus;
  /** ISO; null quando o lead nunca teve atividade. */
  last_activity_at: string | null;
  created_at: string;
}

export type ActiveLeadResolution =
  | { routed: true; leadId: string }
  | {
      routed: false;
      /** Vai para `event_log` como motivo do `agent.activity_unrouted`. */
      reason: "no_open_lead" | "ambiguous_open_leads";
      candidateIds: string[];
    };

/**
 * Qual negócio da pessoa recebe a atividade que acabou de acontecer.
 *
 * O harness trata "lead" como o CONTATO (inbound-turn.ts: `leadId = contact_id`)
 * e `lead_state` é único por contato; o CRM trata lead como NEGÓCIO, e a mesma
 * pessoa pode ter N negócios abertos. Este é o ponteiro entre os dois mundos.
 *
 * Regra (§3.2): negócio ABERTO mais recentemente ativo, preferindo o pipeline
 * default. Quando o alvo é ambíguo ou inexistente, **não adivinha**: devolve
 * `routed: false` e o chamador registra `agent.activity_unrouted` no event_log.
 *
 * Mover o card errado do cliente errado é o único bug desta entrega visível
 * para o cliente final — não-roteado é barulho no log, roteado errado é dano.
 * Por isso "empatou" é ambíguo, e não "escolhe o primeiro".
 */
export function resolveActiveLeadForContact(
  candidates: LeadCandidate[],
  opts: { defaultPipelineId?: string | null } = {},
): ActiveLeadResolution {
  const abertos = candidates.filter((c) => c.status === "open");

  if (abertos.length === 0) {
    return { routed: false, reason: "no_open_lead", candidateIds: [] };
  }

  // Um único negócio aberto não é ambíguo, esteja em que pipeline estiver:
  // é o negócio da pessoa. Exigir o pipeline default aqui deixaria de rotear o
  // caso mais comum de quem usa um pipeline só (que não é o default).
  if (abertos.length === 1) {
    return { routed: true, leadId: abertos[0]!.id };
  }

  const noDefault = opts.defaultPipelineId
    ? abertos.filter((c) => c.pipeline_id === opts.defaultPipelineId)
    : [];
  const pool = noDefault.length > 0 ? noDefault : abertos;

  if (pool.length === 1) {
    return { routed: true, leadId: pool[0]!.id };
  }

  const ordenados = [...pool].sort((a, b) => atividade(b) - atividade(a));
  const topo = atividade(ordenados[0]!);
  const empatados = ordenados.filter((c) => atividade(c) === topo);

  if (empatados.length > 1) {
    // Dois negócios da mesma pessoa tocados no mesmo instante: qualquer escolha
    // aqui é chute com 50% de chance de mover o card errado.
    return {
      routed: false,
      reason: "ambiguous_open_leads",
      candidateIds: empatados.map((c) => c.id),
    };
  }

  return { routed: true, leadId: ordenados[0]!.id };
}

/** Quando este negócio se mexeu pela última vez (cai para a criação). */
function atividade(lead: LeadCandidate): number {
  const iso = lead.last_activity_at ?? lead.created_at;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}
