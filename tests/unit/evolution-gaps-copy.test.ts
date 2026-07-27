import { describe, it, expect } from "vitest";

import { boaNoticia } from "@/components/ai/EvolutionGaps";
import { descricaoResultado, taxaDeAjuda } from "@/app/app/ai/evolution/_client";
import { aggregateEvolution, type EvolutionInput } from "@/lib/ai/evolution/aggregate";

/**
 * Estes dois pedaços são INALCANÇÁVEIS pela tela nas orgs que temos: basta um
 * funil com um passo sem etapa para a lista de lacunas nunca esvaziar, e a taxa
 * de ajuda desta org não cai na faixa abaixo de 0,1. Sem teste, nenhuma das duas
 * lógicas teria prova executável — e as duas nasceram justamente de zeros
 * lisonjeiros, o defeito que passa despercebido por parecer boa notícia.
 *
 * Cada caso asserta a frase ESPECÍFICA do ramo, não uma string comum a vários:
 * o caso sem evidência nenhuma passaria por engano se o texto fosse a
 * meia-verdade de outro ramo, porque o pedaço citado aparece nos dois.
 */
describe("boaNoticia — cada afirmação precisa da sua própria evidência", () => {
  it("sem busca na base, NÃO afirma que as perguntas foram respondidas", () => {
    const t = boaNoticia(0, 12, 3);
    expect(t).not.toContain("toda pergunta encontrou resposta");
    expect(t).toContain("toda conversa achou para onde ir");
    expect(t).toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).toContain("ninguém consultou sua base de conhecimento");
  });

  it("sem encaminhamento, NÃO afirma que as conversas acharam destino", () => {
    const t = boaNoticia(30, 0, 3);
    expect(t).toContain("toda pergunta encontrou resposta");
    expect(t).not.toContain("toda conversa achou para onde ir");
    expect(t).toContain("nenhuma conversa foi encaminhada");
  });

  it("sem funil montado, NÃO elogia funis que não existem", () => {
    // Instalação fresca: o instalador não provisiona pipeline nenhum, então zero
    // funis ⇒ zero lacunas ⇒ a lista fica vazia sem que nada esteja certo.
    const t = boaNoticia(30, 12, 0);
    expect(t).not.toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).toContain("você ainda não tem nenhum funil montado");
  });

  it("sem evidência nenhuma, abre pelo motivo e não pela boa notícia", () => {
    const t = boaNoticia(0, 0, 0);
    expect(t).toContain("Ainda não dá para dizer se algo está travando");
    expect(t).not.toContain("Nada travando");
    expect(t).not.toContain("toda pergunta encontrou resposta");
    expect(t).not.toContain("toda conversa achou para onde ir");
    expect(t).not.toContain("todo passo do atendimento tem uma etapa do funil");
  });

  it("com as três evidências, afirma tudo e sem ressalva", () => {
    const t = boaNoticia(30, 12, 3);
    expect(t).toContain("Nada travando neste período");
    expect(t).toContain("toda pergunta encontrou resposta");
    expect(t).toContain("toda conversa achou para onde ir");
    expect(t).toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).not.toContain("ressalva");
  });
});

describe("descricaoResultado — 'houve atendimento' é mensagem recebida, não custo", () => {
  const base = {
    stage_transitions: 0,
    won: 0,
    lost: 0,
    handoff_rate: 0,
    cost_cents: 0,
    messages_received: 0,
  };

  it("custo alto e ZERO mensagens ainda diz que não houve atendimento", () => {
    // O caso real: `llm_calls` inclui `connection_test` e as chamadas do
    // flywheel, cujo cron julga turnos passados e carimba o custo no dia em que
    // rodou. Se o custo voltar ao guarda, a ressalva some justamente no período
    // em que ela é necessária — e este teste fica vermelho.
    const t = descricaoResultado({ ...base, cost_cents: 1200, handoff_rate: 0.5 });
    expect(t).toContain("Não houve atendimento neste período");
  });

  it("uma mensagem recebida já basta para a descrição normal", () => {
    const t = descricaoResultado({ ...base, messages_received: 1 });
    expect(t).not.toContain("Não houve atendimento");
    expect(t).toContain("compare com o mês anterior");
  });
});

describe("aggregateEvolution expõe o fato exato no payload", () => {
  const vazio: EvolutionInput = {
    range: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z") },
    memoryEntries: [],
    proposalsApplied: [],
    skillInstalls: [],
    skillActivations: [],
    routerDecisions: [],
    knowledgeSearches: [],
    stageTransitions: [],
    costCents: 0,
    inboundCount: 0,
    handoffCount: 0,
    pipelines: [],
  };

  it("messages_received vem de inboundCount, e não de nenhum substituto", () => {
    expect(aggregateEvolution({ ...vazio, inboundCount: 42, costCents: 999 }).outcome.messages_received).toBe(42);
    expect(aggregateEvolution({ ...vazio, costCents: 999 }).outcome.messages_received).toBe(0);
  });

  it("pipelines_evaluated distingue 'tudo mapeado' de 'não há funil'", () => {
    expect(aggregateEvolution(vazio).gaps.pipelines_evaluated).toBe(0);
    const comFunil = aggregateEvolution({
      ...vazio,
      pipelines: [{ name: "Clínica", hints: ["new", "contacted", "qualifying", "qualified", "negotiating", "won", "lost"] }],
    });
    expect(comFunil.gaps.pipelines_evaluated).toBe(1);
    expect(comFunil.gaps.unmapped_agent_steps).toEqual([]);
  });
});

describe("taxaDeAjuda — o zero tem que ser zero de verdade", () => {
  it("zero real é 0", () => {
    expect(taxaDeAjuda(0)).toBe("0");
  });

  it("1 pedido em 5.000 mensagens NÃO vira 0", () => {
    // 0,02 a cada 100. Com uma casa decimal o formatador diria "0", e a tela
    // afirmaria que a IA nunca precisou de gente.
    expect(taxaDeAjuda(1 / 5000)).toBe("menos de 0,1 a cada 100");
  });

  it("acima de 0,1 mostra o número", () => {
    expect(taxaDeAjuda(0.059)).toBe("5,9 a cada 100");
  });
});
