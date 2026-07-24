import { describe, expect, it } from "vitest";

import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";

/**
 * Wave 4 (spec 15 §10.2) — calibração do detector de promessa-de-humano. É o
 * ponto sensível do guardrail anti-alucinação: FALSO-POSITIVO trava o bot em
 * conversa legítima; FALSO-NEGATIVO deixa passar promessa sem caso (o fail-safe
 * cobre, mas o custo é abrir caso desnecessário). Estes casos são CONGELADOS
 * (tests/invariants) — regressão na regex quebra o CI. Puro (sem DB): não lê
 * TEST_DB_CONTAINER, roda na suíte db sem tocar o Postgres.
 */

// DEVE detectar: promessa clara de envolver retaguarda humana/equipe/setor.
const PROMISES: readonly string[] = [
  "vou verificar com a equipe",
  "nosso time vai resolver isso",
  "assim que liberarem eu te aviso",
  "vou acionar o responsável",
  "vou encaminhar pro setor responsável",
  "deixa eu falar com o pessoal do suporte",
  "vou passar pro nosso time técnico",
  "um responsável vai te retornar",
  "vou pedir pra equipe liberar",
  "isso quem resolve é o nosso time",
  // achado na prova E2E real (Wave 7, modelo anthropic real): alvo humano retomado por
  // PRONOME em vez do substantivo — "Já passo o número do pedido (#48291) para eles
  // resolverem junto com a reativação da assinatura."
  "já passo o número do pedido para eles resolverem junto com a reativação",
];

// NÃO detectar: ação própria do bot / frase institucional / checar SISTEMA (≠ humano).
const NON_PROMISES: readonly string[] = [
  "vou te enviar o link",
  "vou confirmar o valor pra você",
  "deixa eu ver aqui rapidinho",
  "vou preparar seu orçamento",
  "já te mando o boleto",
  "vou verificar seu pedido no sistema",
  "nossa equipe está sempre à disposição",
  "vou anotar aqui",
  // pronome sem verbo de resolução depois — só "passar pra eles" não é promessa de AÇÃO.
  "vou passar o recado pra eles mais tarde",
];

describe("detectHumanPromise — calibração (spec 15 §10.2)", () => {
  it.each(PROMISES)("DETECTA promessa de humano: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });

  it.each(NON_PROMISES)("NÃO detecta (fala legítima): %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
  });

  it("é robusto a caixa e acento (normaliza antes de casar)", () => {
    expect(detectHumanPromise("VOU VERIFICAR COM A EQUIPE")).toBe(true);
    expect(detectHumanPromise("vou acionar o RESPONSAVEL")).toBe(true);
  });

  it("no-op em string vazia", () => {
    expect(detectHumanPromise("")).toBe(false);
  });
});
