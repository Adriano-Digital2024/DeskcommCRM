import { describe, expect, it } from "vitest";

import { calculaScore, type SinaisDoLead } from "@/lib/leads/score-formula";
import { FAIXA_LIMITES } from "@/lib/kanban/score-band";

function sinais(over: Partial<SinaisDoLead> = {}): SinaisDoLead {
  return {
    commitments: [],
    objections: [],
    checkpointId: "ck-1",
    qualification: {},
    risco: "em_dia",
    bandAnterior: null,
    ...over,
  };
}

describe("fórmula do score", () => {
  it("lead sem conteúdo NÃO ganha score — e o que falta é dito", () => {
    // O cenário 17. Um lead criado à mão há cinco minutos tem estágio e tem
    // recência, e não tem nada a dizer sobre fechar. Se vitalidade contasse
    // para o mínimo, todo lead novo nasceria com um número.
    const r = calculaScore(sinais({ risco: "em_dia" }));
    expect(r.score).toBeNull();
    expect(r.semSinal).toBe("sem_conteudo");
  });

  it("null e ZERO são coisas diferentes", () => {
    // Zero é uma afirmação ("este lead não fecha"); null é a ausência dela.
    // Confundir os dois põe na tela um veredito que ninguém calculou.
    const r = calculaScore(sinais());
    expect(r.score).toBeNull();
    expect(r.score).not.toBe(0);
  });

  it("conteúdo sem lastro citável também é recusa", () => {
    // Sem o checkpoint, a razão viraria adjetivo e a evidência ficaria vazia —
    // a constraint recusaria o INSERT. Melhor recusar aqui, com motivo legível.
    const r = calculaScore(sinais({ commitments: ["fecha semana que vem"], checkpointId: null }));
    expect(r.score).toBeNull();
    expect(r.semSinal).toBe("sem_lastro_citavel");
  });

  it("a razão CITA as parcelas que mexeram no número", () => {
    const r = calculaScore(
      sinais({
        commitments: ["assinou proposta"],
        objections: ["achou caro"],
        qualification: { need: "automatizar", budget: "5k" },
        risco: "em_dia",
      }),
    );
    // 30 base + 12 compromisso − 8 objeção + 10 BANT + 10 em dia = 54
    expect(r.score).toBe(54);
    expect(r.reason).toContain("compromisso do cliente");
    expect(r.reason).toContain("objeção em aberto");
    expect(r.reason).toContain("itens de qualificação");
    expect(r.reason).toContain("conversa em dia");
  });

  it("a razão é ordenada pelo que MAIS pesou", () => {
    // Quem lê tem de ver primeiro o que decidiu o número, não a ordem em que o
    // programador escreveu as parcelas.
    const r = calculaScore(
      sinais({ commitments: ["a", "b", "c"], objections: ["x"], risco: "em_dia" }),
    );
    expect(r.reason.indexOf("compromissos do cliente")).toBeLessThan(
      r.reason.indexOf("objeção em aberto"),
    );
  });

  it("parcela que não pesou NÃO é citada", () => {
    // "0 objeções" na frase seria ruído com cara de informação.
    const r = calculaScore(sinais({ commitments: ["fecha amanhã"], risco: "em_voo" }));
    expect(r.reason).not.toContain("objeç");
    expect(r.reason).not.toContain("qualificação");
  });

  it("a evidência aponta para o checkpoint que sustenta os fatos", () => {
    const r = calculaScore(sinais({ commitments: ["ok"], checkpointId: "ck-42" }));
    expect(r.evidence.checkpoint_ids).toEqual(["ck-42"]);
  });

  it("recência entra pelo classificador ÚNICO, e muda o número", () => {
    const base = { commitments: ["fecha"], qualification: { need: "x" } };
    const emDia = calculaScore(sinais({ ...base, risco: "em_dia" })).score!;
    const critico = calculaScore(sinais({ ...base, risco: "critico" })).score!;
    expect(emDia - critico).toBe(30); // +10 contra −20
  });

  it("o score nunca escapa de 0..100, mesmo com sinal extremo", () => {
    const alto = calculaScore(
      sinais({
        commitments: ["a", "b", "c", "d", "e"],
        qualification: { a: "1", b: "2", c: "3", d: "4", e: "5" },
        risco: "em_dia",
      }),
    );
    const baixo = calculaScore(
      sinais({ objections: ["a", "b", "c", "d", "e"], risco: "critico" }),
    );
    expect(alto.score).toBeLessThanOrEqual(100);
    expect(baixo.score).toBeGreaterThanOrEqual(0);
  });

  it("a faixa devolvida é sempre GRAVÁVEL — a fórmula não pode brigar com o CHECK", () => {
    // A mesma varredura do invariante, aqui na origem: se a fórmula produzisse
    // um par (score, faixa) fora dos limites, o worker escreveria e o banco
    // recusaria — erro em produção, no lead que oscila.
    const anteriores = [null, "frio", "morno", "quente"] as const;
    for (const risco of ["em_dia", "em_voo", "em_risco", "critico"] as const) {
      for (let n = 0; n <= 5; n++) {
        for (const anterior of anteriores) {
          const r = calculaScore(
            sinais({
              commitments: Array.from({ length: n }, (_, i) => `c${i}`),
              objections: Array.from({ length: 5 - n }, (_, i) => `o${i}`),
              risco,
              bandAnterior: anterior,
            }),
          );
          if (r.score === null || r.band === null) continue;
          const lim = FAIXA_LIMITES[r.band];
          expect(
            r.score >= lim.min && r.score <= lim.max,
            `score ${r.score} com faixa '${r.band}' seria recusado pelo banco`,
          ).toBe(true);
        }
      }
    }
  });

  it("é DETERMINÍSTICA: mesma entrada, mesmo número e mesma frase", () => {
    // O ponto inteiro de ser fórmula. Com um modelo, duas chamadas iguais
    // devolveriam frases diferentes — e a razão deixaria de ser derivação.
    const entrada = sinais({ commitments: ["a"], objections: ["b"], qualification: { c: "d" } });
    const um = calculaScore(entrada);
    const dois = calculaScore(entrada);
    expect(um).toEqual(dois);
  });
});

describe("a razão é DERIVADA do cálculo, e isso é verificável", () => {
  /**
   * A C1 exige `reason` derivado, e o @Assistente notou que olhando o RESULTADO
   * uma frase gerada é indistinguível de uma derivada. Este teste desfaz o
   * empate: ele RECONSTRÓI o score a partir da frase.
   *
   * Se a frase citar parcela que não entrou na conta, ou omitir uma que entrou,
   * ou trouxer número diferente do que somou, a reconstrução não fecha. Uma
   * frase gerada por modelo passaria no olho e falharia aqui — que é
   * exatamente a distinção que a lei precisa.
   */
  function somaDaFrase(reason: string): number {
    // As parcelas são escritas como "+12 ..." / "−8 ..." (menos tipográfico).
    const parcelas = [...reason.matchAll(/([+−])(\d+)/g)];
    return parcelas.reduce(
      (soma, m) => soma + (m[1] === "+" ? 1 : -1) * Number(m[2]),
      0,
    );
  }

  const BASE_DA_FORMULA = 30;

  it("somar os números da frase reproduz o score (fora do clamp)", () => {
    const casos: SinaisDoLead[] = [
      sinais({ commitments: ["a"], risco: "em_dia" }),
      sinais({ objections: ["x"], risco: "critico" }),
      sinais({ commitments: ["a", "b"], objections: ["x"], qualification: { n: "1" }, risco: "em_risco" }),
      sinais({ qualification: { a: "1", b: "2", c: "3" }, risco: "em_voo" }),
    ];
    for (const caso of casos) {
      const r = calculaScore(caso);
      expect(r.score).not.toBeNull();
      expect(
        BASE_DA_FORMULA + somaDaFrase(r.reason),
        `a frase "${r.reason}" não reconstrói o score ${r.score}`,
      ).toBe(r.score);
    }
  });

  it("a frase não cita parcela que a conta não usou", () => {
    // Um "+5 itens de qualificação" numa frase de lead sem BANT seria a marca
    // de texto gerado ao lado do número em vez de derivado dele.
    const r = calculaScore(sinais({ commitments: ["fecha"], risco: "em_dia" }));
    expect(r.reason).not.toMatch(/qualificação|objeç/);
    expect(BASE_DA_FORMULA + somaDaFrase(r.reason)).toBe(r.score);
  });
});
