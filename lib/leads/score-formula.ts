import type { RiskBucket } from "@/lib/leads/risk-radar";
import { resolveBand, type ScoreBand } from "@/lib/kanban/score-band";

/**
 * O score é FÓRMULA, não chamada de modelo — e a diferença não é de custo.
 *
 * Com fórmula, o `reason` é DERIVADO do cálculo: cada parcela que mexeu no
 * número aparece na frase, e "número sem porquê" fica impossível por
 * construção. Com um modelo, a frase seria gerada AO LADO do número, e a lei
 * ("score sem razão não é gravado") passaria a ser cumprida na aparência —
 * a constraint aceitaria uma explicação que não explica nada.
 *
 * É também o que torna o score discutível: um humano que discorda pode apontar
 * QUAL parcela está errada, em vez de discordar de um oráculo.
 */

/** O que a fórmula lê. Nada aqui é inventado: tudo já existe no sistema. */
export interface SinaisDoLead {
  /** `lead_checkpoints.commitments` do checkpoint mais recente. */
  commitments: string[];
  /** `lead_checkpoints.objections` do mesmo checkpoint. */
  objections: string[];
  /** Id do checkpoint que sustenta os dois acima — o lastro citável. */
  checkpointId: string | null;
  /** `lead_state.qualification` (BANT): só as chaves preenchidas contam. */
  qualification: Record<string, unknown>;
  /**
   * Recência, VINDA do classificador único (`classifyRisk`).
   *
   * Não se calcula janela de tempo aqui. Escrever "sem resposta há N horas"
   * dentro da fórmula criaria um segundo classificador ESCONDIDO DENTRO DE UM
   * CÁLCULO — o pior lugar possível, porque ninguém procuraria por ele lá.
   */
  risco: RiskBucket;
  /** Faixa anterior, para a histerese. `null` na primeira vez. */
  bandAnterior: ScoreBand | null;
}

export interface ScoreCalculado {
  /** `null` = sinal insuficiente. NUNCA zero — zero é uma afirmação. */
  score: number | null;
  reason: string;
  evidence: { checkpoint_ids?: string[]; activity_ids?: string[]; message_ids?: string[] };
  band: ScoreBand | null;
  /** Por que não deu score, quando não deu — para o log, não para a tela. */
  semSinal?: "sem_lastro_citavel" | "sem_conteudo";
}

/** Uma parcela do cálculo: o quanto mexeu e como isso se lê em português. */
interface Parcela {
  pontos: number;
  frase: string;
}

const BASE = 30;
const POR_COMPROMISSO = 12;
const POR_OBJECAO = -8;
const POR_CAMPO_BANT = 5;
const TETO_COMPROMISSOS = 3;
const TETO_OBJECOES = 3;
const TETO_BANT = 4;

/** Recência entra como AJUSTE, com os buckets do classificador único. */
const PESO_RISCO: Record<RiskBucket, number> = {
  em_dia: 10,
  em_voo: 0,
  em_risco: -10,
  critico: -20,
};

const FRASE_RISCO: Record<RiskBucket, string> = {
  em_dia: "conversa em dia",
  em_voo: "resposta da IA a caminho",
  em_risco: "sem resposta além do esperado",
  critico: "sem resposta há muito tempo",
};

function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`;
}

/**
 * Calcula o score, ou recusa a calcular.
 *
 * A RECUSA É O CAMINHO NORMAL para um lead novo, e isso é deliberado: um lead
 * criado à mão há cinco minutos tem estágio e tem recência, e não tem nada a
 * dizer sobre fechar. Por isso VITALIDADE NÃO CONTA PARA O MÍNIMO — só conteúdo
 * conta (compromisso, objeção ou BANT). Sem essa cláusula, todo lead novo
 * nasceria com um número, e o cenário 17 falharia por dentro parecendo sucesso.
 *
 * E exige-se LASTRO CITÁVEL: sem o checkpoint que sustenta os fatos, a razão
 * viraria adjetivo e a evidência ficaria vazia — a constraint recusaria a
 * gravação, e com razão. Melhor recusar aqui, com motivo legível, do que
 * descobrir no INSERT.
 */
export function calculaScore(sinais: SinaisDoLead): ScoreCalculado {
  const compromissos = sinais.commitments.filter((c) => c.trim() !== "");
  const objecoes = sinais.objections.filter((o) => o.trim() !== "");
  const camposBant = Object.entries(sinais.qualification).filter(
    ([, v]) => typeof v === "string" && v.trim() !== "",
  ).length;

  const temConteudo = compromissos.length > 0 || objecoes.length > 0 || camposBant > 0;
  if (!temConteudo) {
    return {
      score: null,
      reason: "",
      evidence: {},
      band: null,
      semSinal: "sem_conteudo",
    };
  }
  if (sinais.checkpointId === null) {
    return {
      score: null,
      reason: "",
      evidence: {},
      band: null,
      semSinal: "sem_lastro_citavel",
    };
  }

  const parcelas: Parcela[] = [];
  const nComp = Math.min(compromissos.length, TETO_COMPROMISSOS);
  if (nComp > 0) {
    parcelas.push({
      pontos: nComp * POR_COMPROMISSO,
      frase: plural(nComp, "compromisso do cliente", "compromissos do cliente"),
    });
  }
  const nObj = Math.min(objecoes.length, TETO_OBJECOES);
  if (nObj > 0) {
    parcelas.push({
      pontos: nObj * POR_OBJECAO,
      frase: plural(nObj, "objeção em aberto", "objeções em aberto"),
    });
  }
  const nBant = Math.min(camposBant, TETO_BANT);
  if (nBant > 0) {
    parcelas.push({
      pontos: nBant * POR_CAMPO_BANT,
      frase: plural(nBant, "item de qualificação", "itens de qualificação"),
    });
  }
  parcelas.push({ pontos: PESO_RISCO[sinais.risco], frase: FRASE_RISCO[sinais.risco] });

  const bruto = parcelas.reduce((soma, p) => soma + p.pontos, BASE);
  const score = Math.max(0, Math.min(100, bruto));

  // A razão é a LEITURA das parcelas que entraram, em ordem de peso absoluto —
  // o que mais mexeu no número aparece primeiro. Nada aqui é gerado: se uma
  // parcela não pesou, ela não é citada.
  const reason = parcelas
    .filter((p) => p.pontos !== 0)
    .sort((a, b) => Math.abs(b.pontos) - Math.abs(a.pontos))
    .map((p) => `${p.pontos > 0 ? "+" : "−"}${Math.abs(p.pontos)} ${p.frase}`)
    .join(", ");

  return {
    score,
    reason: reason === "" ? "sem parcelas relevantes além da base" : reason,
    evidence: { checkpoint_ids: [sinais.checkpointId] },
    band: resolveBand(score, sinais.bandAnterior),
  };
}
