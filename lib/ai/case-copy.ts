/**
 * Tradução leiga (pt-br) dos casos humanos (spec 15) — a superfície onde o
 * atendente vê os bloqueios que a IA não resolve sozinha e devolve a
 * resposta. Um caso NÃO é handoff: a IA segue conversando com o cliente,
 * só que espera o humano resolver um bloqueio pontual. Nunca mostrar enum
 * cru (status/kind/actor_kind/source) ao atendente — sempre via este mapa.
 */
import type { CaseEvent, CaseHumanAction, CaseStatus } from "@/hooks/ai/useCases";

export const STATUS_LABEL: Record<CaseStatus, string> = {
  awaiting_human: "Aguardando você",
  awaiting_lead: "Aguardando o cliente",
  resolved: "Concluído",
  escalated: "Virou atendimento humano",
  cancelled: "Cancelado",
};

export const STATUS_BADGE_VARIANT: Record<CaseStatus, "warning" | "info" | "success" | "neutral"> = {
  awaiting_human: "warning",
  awaiting_lead: "info",
  resolved: "success",
  escalated: "neutral",
  cancelled: "neutral",
};

/**
 * Por que o painel de resposta está desabilitado fora de `awaiting_human`.
 * Sem entrada para `awaiting_human` de propósito — ali o painel está ativo.
 */
export const CASE_REPLY_DISABLED_REASON: Partial<Record<CaseStatus, string>> = {
  awaiting_lead: "Aguardando o cliente responder — a IA avisa você quando tiver a informação.",
  resolved: "Este caso já foi concluído.",
  escalated: "Este caso virou atendimento humano — não precisa mais de resposta aqui.",
  cancelled: "Este caso foi cancelado.",
};

export interface CaseActionOption {
  action: CaseHumanAction;
  label: string;
  help: string;
}

/** As 3 ações do POST .../reply — rótulo + efeito em 1 linha (não é óbvio). */
export const CASE_ACTIONS: CaseActionOption[] = [
  {
    action: "resolved",
    label: "Concluí",
    help: "A IA avisa o cliente e encerra o assunto.",
  },
  {
    action: "need_lead_info",
    label: "Preciso de info do cliente",
    help: "A IA pergunta ao cliente e o caso volta pra você quando ele responder.",
  },
  {
    action: "escalate",
    label: "Não consigo — passar pra humano",
    help: "Sai da IA: a conversa vira um atendimento humano de verdade.",
  },
];

const EVENT_LABEL: Record<CaseEvent["kind"], string> = {
  opened: "A IA abriu o caso",
  human_replied: "Você respondeu",
  lead_asked: "A IA perguntou ao cliente",
  lead_provided: "O cliente respondeu",
  lead_unresponsive: "O cliente não respondeu a tempo",
  resolved: "Concluído",
  escalated: "Virou atendimento humano",
  cancelled: "Cancelado",
};

const HUMAN_ACTION_LABEL: Record<CaseHumanAction, string> = {
  resolved: "Você concluiu o caso",
  need_lead_info: "Você pediu uma informação ao cliente",
  escalate: "Você decidiu passar para atendimento humano",
};

/** Traduz um evento da timeline pra uma frase pt-br — nunca o enum cru. */
export function caseEventLabel(event: Pick<CaseEvent, "kind" | "actor_kind" | "human_action">): string {
  if (event.kind === "opened" && event.actor_kind === "system") {
    return "O sistema abriu o caso automaticamente";
  }
  if (event.kind === "human_replied" && event.human_action) {
    return HUMAN_ACTION_LABEL[event.human_action];
  }
  return EVENT_LABEL[event.kind] ?? "Atualização do caso";
}
