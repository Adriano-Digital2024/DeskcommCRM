import { describe, it, expect } from "vitest";

import { boaNoticia } from "@/components/ai/EvolutionGaps";

/**
 * A frase de "nada travando" é INALCANÇÁVEL pela tela nas orgs que temos: basta
 * um funil com um passo sem etapa para a lista nunca ficar vazia. Sem este teste
 * a lógica das três sub-afirmações não teria nenhuma prova executável — e foi
 * exatamente aí que morava o zero lisonjeiro: um guarda único autorizava as três
 * frases com a evidência de uma.
 */
describe("boaNoticia — cada afirmação precisa da sua própria evidência", () => {
  it("sem busca na base, NÃO afirma que as perguntas foram respondidas", () => {
    const t = boaNoticia(0, 12);
    expect(t).not.toContain("toda pergunta encontrou resposta");
    expect(t).toContain("toda conversa achou para onde ir");
    expect(t).toContain("ninguém consultou sua base");
  });

  it("sem encaminhamento, NÃO afirma que as conversas acharam destino", () => {
    const t = boaNoticia(30, 0);
    expect(t).toContain("toda pergunta encontrou resposta");
    expect(t).not.toContain("toda conversa achou para onde ir");
    expect(t).toContain("nenhuma conversa foi encaminhada");
  });

  it("sem nada, só afirma o funil — que é estado atual, não evento do período", () => {
    const t = boaNoticia(0, 0);
    expect(t).not.toContain("toda pergunta encontrou resposta");
    expect(t).not.toContain("toda conversa achou para onde ir");
    expect(t).toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).toContain("a lista está calada, não elogiosa");
  });

  it("com as duas evidências, afirma tudo e sem ressalva", () => {
    const t = boaNoticia(30, 12);
    expect(t).toContain("toda pergunta encontrou resposta");
    expect(t).toContain("toda conversa achou para onde ir");
    expect(t).toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).not.toContain("ressalva");
  });
});
