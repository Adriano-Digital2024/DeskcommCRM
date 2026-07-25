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
  | "handoff_triggered"
  | "next_action_approved"
  | "next_action_dismissed";

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  stage_changed: "Mudou de estágio",
  note: "Anotação",
  ai_turn: "Atendimento da IA",
  send_vetoed: "Envio bloqueado",
  handoff_triggered: "Passou para humano",
  // A RECUSA é sinal, não ausência de sinal: "o humano viu e disse não" é o que
  // impede o agente de repropor o mesmo. Ignorar sem registro faz a IA insistir
  // no que já foi negado — por isso os dois lados geram atividade.
  next_action_approved: "Próxima ação aprovada",
  next_action_dismissed: "Próxima ação descartada",
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
export type ActivityActorShape = "filled" | "ring" | "dashed";

/**
 * TRÊS desenhos, os mesmos do card: preenchido = gente, anel = agente,
 * tracejado = nem um nem outro.
 *
 * A forma carrega a leitura GROSSA (foi gente / foi agente / não foi nenhum dos
 * dois); a distinção fina entre "Automação" e "Autor não registrado" já está no
 * TEXTO, que fica ao lado. Um quarto desenho obrigaria o usuário a decorar um
 * alfabeto no kanban e outro na timeline, para dizer o que a palavra já diz.
 */
export function actorShape(actorKind: string | null): ActivityActorShape {
  if (actorKind === "user" || actorKind === "contact") return "filled";
  if (actorKind === "ai") return "ring";
  return "dashed";
}

/**
 * QUEM agiu, com nome quando se sabe o nome.
 *
 * "Agente" e "Você/time" respondem o TIPO de ator; numa org com três agentes e
 * cinco atendentes, isso não responde a pergunta que o humano faz olhando a
 * timeline, que é "quem fez isso?". O genérico vira último recurso — e continua
 * existindo porque nome pode faltar (agente apagado, usuário sem full_name).
 */
export function actorName(
  actorKind: string | null,
  nomes: { agente?: string | null; usuario?: string | null } = {},
): string {
  if (actorKind === "ai" && nomes.agente) return nomes.agente;
  if ((actorKind === "user" || actorKind === "contact") && nomes.usuario) return nomes.usuario;
  return actorLabel(actorKind);
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
