import { describe, expect, it } from "vitest";

import { agrupaTimeline, ehBlocoColapsavel } from "@/lib/leads/timeline-grouping";
import type { TimelineItemView } from "@/lib/types/contacts";

let n = 0;
function item(over: Partial<TimelineItemView> = {}): TimelineItemView {
  n += 1;
  return {
    id: `a${n}`,
    organization_id: "org",
    lead_id: "lead",
    contact_id: "contato",
    source_module: "ai",
    source_id: null,
    type: "ai_turn",
    payload: {},
    metadata: {},
    performed_at: "2026-07-25T10:00:00Z",
    performed_by_user_id: null,
    actor_kind: "ai",
    actor_agent_id: "agente-1",
    reason: null,
    evidence: null,
    ...over,
  };
}

describe("agrupamento da timeline", () => {
  it("ações seguidas do mesmo agente, no mesmo minuto, viram um bloco", () => {
    const blocos = agrupaTimeline([
      item({ performed_at: "2026-07-25T10:00:30Z" }),
      item({ performed_at: "2026-07-25T10:00:20Z" }),
      item({ performed_at: "2026-07-25T10:00:10Z" }),
    ]);
    expect(blocos).toHaveLength(1);
    expect(blocos[0]!.tipo).toBe("grupo");
    expect(ehBlocoColapsavel(blocos[0]!)).toBe(true);
  });

  it("atores diferentes NÃO se juntam, mesmo lado a lado", () => {
    const blocos = agrupaTimeline([
      item({ actor_kind: "ai" }),
      item({ actor_kind: "user", actor_agent_id: null, performed_by_user_id: "u1" }),
    ]);
    expect(blocos).toHaveLength(2);
  });

  it("DECISÃO HUMANA nunca colapsa, nem cercada por ações do mesmo ator", () => {
    // As únicas linhas que contêm DECISÃO e não relato. Escondê-las num bloco
    // desfaz o que a wave 4 pagou para construir — e o pior é que o bloco
    // ficaria com o rótulo "3 ações", contando a decisão como ação qualquer.
    const blocos = agrupaTimeline([
      item({ actor_kind: "user", performed_by_user_id: "u1", type: "lead_edited" }),
      item({ actor_kind: "user", performed_by_user_id: "u1", type: "next_action_dismissed" }),
      item({ actor_kind: "user", performed_by_user_id: "u1", type: "lead_edited" }),
    ]);
    expect(blocos).toHaveLength(3);
    expect(blocos[1]!.tipo).toBe("item");
  });

  it("O QUE CHEGOU AO VIVO fica FORA do bloco — o novo é visto, não contado", () => {
    // O cruzamento dos dois requisitos: se o evento novo caísse no bloco, a
    // timeline iria de "2 ações" para "3 ações" e ninguém veria o que chegou.
    const a = item({ performed_at: "2026-07-25T10:00:30Z" });
    const b = item({ performed_at: "2026-07-25T10:00:20Z" });
    const novo = item({ performed_at: "2026-07-25T10:00:25Z" });

    const semAoVivo = agrupaTimeline([a, novo, b]);
    expect(semAoVivo).toHaveLength(1); // todos juntos

    const comAoVivo = agrupaTimeline([a, novo, b], new Set([novo.id]));
    expect(comAoVivo).toHaveLength(3); // o novo separa o bloco em dois
    expect(comAoVivo[1]).toMatchObject({ tipo: "item", aoVivo: true });
  });

  it("distância maior que a janela quebra o bloco — pausa é informação", () => {
    const blocos = agrupaTimeline([
      item({ performed_at: "2026-07-25T12:00:00Z" }),
      item({ performed_at: "2026-07-25T10:00:00Z" }),
    ]);
    expect(blocos).toHaveLength(2);
  });

  it("um item sozinho não é apresentado como bloco", () => {
    const blocos = agrupaTimeline([item()]);
    expect(blocos).toHaveLength(1);
    expect(ehBlocoColapsavel(blocos[0]!)).toBe(false);
  });

  it("nenhum item se perde no agrupamento", () => {
    // A garantia mais chata e a que ninguém escreve: agrupar não pode COMER
    // linha. Um bug de índice aqui esconderia atividade sem nada acusar.
    const itens = [
      item({ actor_kind: "ai" }),
      item({ actor_kind: "ai" }),
      item({ actor_kind: "user", type: "next_action_approved" }),
      item({ actor_kind: "user", type: "lead_edited" }),
      item({ actor_kind: "ai", performed_at: "2026-07-25T08:00:00Z" }),
    ];
    const blocos = agrupaTimeline(itens, new Set([itens[3]!.id]));
    const total = blocos.reduce(
      (soma, b) => soma + (b.tipo === "item" ? 1 : b.itens.length),
      0,
    );
    expect(total).toBe(itens.length);
  });

  it("lista vazia não quebra", () => {
    expect(agrupaTimeline([])).toEqual([]);
  });
});
