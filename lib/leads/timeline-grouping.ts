import type { TimelineItemView } from "@/lib/types/contacts";

/**
 * O agrupamento da timeline do dossiê.
 *
 * Três regras, e cada uma existe por um defeito específico:
 *
 *  1. COLAPSA por ator E por NATUREZA, não só por ator. `Agente respondeu · 3
 *     ações` é ótimo para relato; mas `next_action_approved` e
 *     `next_action_dismissed` são as ÚNICAS linhas da timeline que contêm uma
 *     DECISÃO e não um relato — escondê-las num bloco é o oposto do que a Wave 4
 *     pagou para construir.
 *
 *  2. O QUE CHEGOU AO VIVO NESTA SESSÃO NÃO COLAPSA. Se o evento novo caísse
 *     dentro de um bloco já fechado, a timeline iria de "3 ações" para "4 ações"
 *     e o usuário NÃO VERIA O QUE CHEGOU: o requisito de agrupar esconderia o
 *     que o requisito de tempo real promete mostrar. Expandir o bloco sozinho
 *     seria pior — mudaria retroativamente o que já está na tela e a pessoa
 *     perde onde estava lendo. Ele se junta ao bloco numa abertura nova.
 *
 *  3. Só colapsa dentro da MESMA JANELA de tempo: eventos do mesmo ator com
 *     horas de distância são episódios diferentes da vida do lead, e juntá-los
 *     apagaria a informação de que houve uma pausa.
 */

/** Tipos que NUNCA colapsam: contêm decisão humana, não relato. */
const NUNCA_COLAPSA = new Set(["next_action_approved", "next_action_dismissed"]);

/** Janela do agrupamento. O contrato fala em "mesmo minuto". */
const JANELA_MS = 60_000;

export type BlocoDaTimeline =
  | { tipo: "item"; item: TimelineItemView; aoVivo: boolean }
  | {
      tipo: "grupo";
      /** Quem agiu — o rótulo do bloco sai daqui. */
      actorKind: string;
      itens: TimelineItemView[];
    };

function chaveDoAtor(item: TimelineItemView): string {
  return `${item.actor_kind ?? "desconhecido"}:${item.actor_agent_id ?? item.performed_by_user_id ?? ""}`;
}

function instante(item: TimelineItemView): number {
  return new Date(item.performed_at).getTime();
}

/**
 * Agrupa a timeline já ordenada (mais recente primeiro, como a rota devolve).
 *
 * `chegouAoVivo` são os ids recebidos por realtime NESTA sessão — eles saem
 * sozinhos, sem exceção, e é isso que faz o novo ser VISTO em vez de contado.
 */
export function agrupaTimeline(
  itens: TimelineItemView[],
  chegouAoVivo: Set<string> = new Set(),
): BlocoDaTimeline[] {
  const blocos: BlocoDaTimeline[] = [];

  for (const item of itens) {
    const aoVivo = chegouAoVivo.has(item.id);
    const isolado = aoVivo || NUNCA_COLAPSA.has(item.type);

    if (isolado) {
      blocos.push({ tipo: "item", item, aoVivo });
      continue;
    }

    const ultimo = blocos[blocos.length - 1];
    const podeJuntar =
      ultimo !== undefined &&
      ultimo.tipo === "grupo" &&
      ultimo.actorKind === chaveDoAtor(item) &&
      Math.abs(instante(ultimo.itens[ultimo.itens.length - 1]!) - instante(item)) <= JANELA_MS;

    if (podeJuntar && ultimo.tipo === "grupo") {
      ultimo.itens.push(item);
      continue;
    }

    // Um item sozinho vira grupo de um; quem renderiza decide mostrar o bloco
    // só a partir de dois. Assim a regra de junção fica num lugar só, em vez de
    // ficar metade aqui e metade no componente.
    blocos.push({ tipo: "grupo", actorKind: chaveDoAtor(item), itens: [item] });
  }

  return blocos;
}

/** Um grupo só é apresentado como bloco quando tem mais de um item. */
export function ehBlocoColapsavel(b: BlocoDaTimeline): boolean {
  return b.tipo === "grupo" && b.itens.length > 1;
}
