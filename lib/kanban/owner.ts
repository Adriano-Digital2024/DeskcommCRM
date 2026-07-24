import type { Lead, OwnerKind } from "@/lib/types/leads";
import type { AssignableAgent } from "@/hooks/kanban/useAssignableAgents";

/** O que o card precisa saber sobre o dono para desenhá-lo. */
export interface OwnerDisplay {
  kind: OwnerKind;
  name: string | null;
  /** Versão publicada do agente HOJE — resolvida na exibição, nunca no lead. */
  agentVersion: number | null;
}

/**
 * Resolve o dono do negócio (0070) para exibição: humano, agente ou ninguém.
 *
 * Função pura e única — card, filtro e (nas waves seguintes) dossiê e radar
 * leem daqui. Resolver "quem é o dono" dentro de componente é como o board
 * acaba com duas verdades sobre a mesma pessoa.
 *
 * Tolerante a dado incompleto de propósito: id de dono cujo nome ainda não
 * carregou vira `name: null` (o badge cai para o rótulo genérico) — nunca
 * "Sem responsável", que mentiria dizendo que o negócio está órfão.
 */
export function resolveLeadOwner(
  lead: Pick<Lead, "owner_kind" | "owner_user_id" | "owner_agent_id">,
  ownerNames: Map<string, string | null> | undefined,
  agentsById: Map<string, AssignableAgent> | undefined,
): OwnerDisplay {
  if (lead.owner_kind === "ai" && lead.owner_agent_id) {
    const agent = agentsById?.get(lead.owner_agent_id);
    return {
      kind: "ai",
      name: agent?.name ?? null,
      agentVersion: agent?.version_number ?? null,
    };
  }

  if (lead.owner_kind === "user" && lead.owner_user_id) {
    return {
      kind: "user",
      name: ownerNames?.get(lead.owner_user_id) ?? null,
      agentVersion: null,
    };
  }

  // Bancos anteriores à 0070 (ou escrita legada) têm owner_user_id sem
  // owner_kind: o dono humano continua aparecendo, sem depender do backfill.
  if (lead.owner_user_id) {
    return {
      kind: "user",
      name: ownerNames?.get(lead.owner_user_id) ?? null,
      agentVersion: null,
    };
  }

  return { kind: null, name: null, agentVersion: null };
}
