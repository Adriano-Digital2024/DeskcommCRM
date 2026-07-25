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

/** Quando o tipo é legado/desconhecido, a linha ainda é honesta — sem jargão. */
export const ACTIVITY_LABEL_FALLBACK = "Atividade registrada";

/**
 * Rótulo para exibir. Aceita `string` porque o banco tem histórico anterior a
 * este vocabulário — o que não se pode é ESCREVER fora dele.
 *
 * O fallback NÃO devolve o identificador cru: era exatamente isso que punha
 * "stage_changed" no rosto do usuário, e reintroduzir aqui seria trazer de
 * volta, pelo lado da leitura, o defeito que este arquivo existe para matar.
 * Nenhum teste pegaria: "stage_changed" não é uuid, então a asserção que caça
 * uuid na tela continuaria verde.
 */
export function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type as ActivityType] ?? ACTIVITY_LABEL_FALLBACK;
}

/** Como o marcador do ator é desenhado (BRIEFING §5: forma, nunca cor). */
export type ActivityActorShape = "filled" | "ring" | "square" | "dashed";

/**
 * Humano = disco PREENCHIDO; agente = círculo VAZADO COM ANEL (a mesma
 * geometria do OwnerBadge no card); sistema/regra = QUADRADO (BRIEFING §5 §2 da
 * timeline); autor NÃO REGISTRADO = TRACEJADO, reusando o desenho de "sem dono"
 * que o OwnerBadge já tem.
 *
 * A separação entre "sistema" e "não sei quem foi" é o ponto: sistema é um ator
 * conhecido — o produto agiu — e merece o quadrado do briefing; `actor_kind`
 * null (a coluna é nullable) é ausência de informação, e desenhar quadrado nos
 * dois casos fazia a tela afirmar autoria que ninguém registrou.
 */
export function actorShape(actorKind: string | null): ActivityActorShape {
  if (actorKind === "user" || actorKind === "contact") return "filled";
  if (actorKind === "ai") return "ring";
  if (actorKind === "system" || actorKind === "rule") return "square";
  return "dashed";
}

/**
 * Quem agiu, em uma palavra — vai ao lado do rótulo na linha.
 *
 * SEMPRE devolve texto, porque `actorShape` sempre desenha: marcador sem
 * legenda é ruído que o leitor não consegue decifrar. As duas funções têm de
 * concordar, inclusive no caso desconhecido.
 */
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
      return "Autor não registrado";
  }
}
