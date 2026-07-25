/**
 * O vocabulário da timeline — fonte ÚNICA, escrita e leitura.
 *
 * Esta é a terceira vez, nesta entrega, que duas listas de strings que
 * precisavam concordar viviam em arquivos diferentes: o LGPD dizia
 * `customer_redact` e o banco exigia `redact`; os workers filtravam pelo
 * vocabulário errado; e aqui a tela conhecia 13 rótulos com ponto
 * (`lead.stage_changed`) enquanto o banco grava 5 com underscore
 * (`stage_changed`). Interseção: ZERO. Toda linha que já existiu caiu no
 * fallback e mostrou o nome cru do tipo.
 *
 * O gate é o compilador: `ACTIVITY_LABELS` é `Record<ActivityType, string>`
 * EXAUSTIVO. Tipo novo sem rótulo não compila — não existe caminho para
 * divergir em silêncio de novo.
 *
 * Deliberadamente SEM check constraint no banco: um clone com tipo legado que
 * não conhecemos quebraria no `update.sh` (doutrina de migrations). O banco
 * aceita; quem escreve daqui é que fica preso ao vocabulário.
 */
export type ActivityType =
  | "stage_changed"
  | "note"
  | "ai_turn"
  | "send_vetoed"
  | "handoff_triggered";

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  stage_changed: "Mudou de estágio",
  note: "Anotação",
  ai_turn: "Atendimento da IA",
  send_vetoed: "Envio bloqueado",
  handoff_triggered: "Passou para humano",
};

/**
 * Rótulo para exibir. Aceita `string` porque o banco tem histórico anterior a
 * este vocabulário — o que não se pode é ESCREVER fora dele.
 */
export function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type as ActivityType] ?? type;
}

/** Como o marcador do ator é desenhado (BRIEFING §5: forma, nunca cor). */
export type ActivityActorShape = "filled" | "ring" | "square";

/**
 * Humano = disco PREENCHIDO; agente = círculo VAZADO COM ANEL; sistema/regra =
 * quadrado. É a mesma geometria do OwnerBadge no card — se divergirem, a mesma
 * pessoa lê dois desenhos para o mesmo fato em duas telas.
 */
export function actorShape(actorKind: string | null): ActivityActorShape {
  if (actorKind === "user" || actorKind === "contact") return "filled";
  if (actorKind === "ai") return "ring";
  return "square";
}

/** Quem agiu, em uma palavra — vai ao lado do rótulo na linha. */
export function actorLabel(actorKind: string | null): string {
  switch (actorKind) {
    case "user":
      return "Você/time";
    case "ai":
      return "Agente";
    case "contact":
      return "Cliente";
    case "rule":
      return "Automação";
    case "system":
      return "Sistema";
    default:
      return "";
  }
}
