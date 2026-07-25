import { beforeEach, describe, expect, it } from "vitest";

import {
  ehEcoLocal,
  liberarEcoLocal,
  limparEcosLocais,
  marcarEcoLocal,
} from "@/lib/kanban/local-echo";

const LEAD = "11111111-1111-4111-8111-111111111111";
const OUTRO = "22222222-2222-4222-8222-222222222222";
const T0 = 1_000_000;

describe("eco local do pulso", () => {
  beforeEach(() => limparEcosLocais());

  it("suprime TODAS as escritas da mesma ação, não só a primeira", () => {
    // O defeito do 12.c: arrastar um card produz duas escritas na linha —
    // `stage_id` na rota, e `last_activity_at` quando a atividade
    // `stage_changed` entra, três consultas depois. A versão que consumia a
    // marca gastava-a na primeira, e a aba que agiu pulsava na segunda.
    marcarEcoLocal(LEAD, T0);
    expect(ehEcoLocal(LEAD, T0 + 60)).toBe(true);
    expect(ehEcoLocal(LEAD, T0 + 172)).toBe(true);
    expect(ehEcoLocal(LEAD, T0 + 400)).toBe(true);
  });

  it("a janela é o tempo REAL da mutação, não uma constante", () => {
    // Handler lento (VPS modesta, cascata longa): 3s e ainda em voo. Uma
    // janela fixa de 1,5s ou 2s já teria vencido no meio da própria ação.
    marcarEcoLocal(LEAD, T0);
    expect(ehEcoLocal(LEAD, T0 + 3_000)).toBe(true);
    liberarEcoLocal(LEAD, T0 + 3_200);
    expect(ehEcoLocal(LEAD, T0 + 3_900)).toBe(true); // evento atrasado, na folga
  });

  it("depois de assentar, a folga é curta e acaba", () => {
    marcarEcoLocal(LEAD, T0);
    liberarEcoLocal(LEAD, T0 + 200);
    expect(ehEcoLocal(LEAD, T0 + 1_200)).toBe(true); // 1000ms após assentar
    expect(ehEcoLocal(LEAD, T0 + 1_201)).toBe(false);
  });

  it("mutação que nunca assenta cai na rede de segurança", () => {
    // Aba suspensa, rede caída, onSettled que não roda. Sem o fallback a marca
    // ficaria para sempre e o lead pararia de pulsar de vez — o erro caro.
    marcarEcoLocal(LEAD, T0);
    expect(ehEcoLocal(LEAD, T0 + 4_000)).toBe(true);
    expect(ehEcoLocal(LEAD, T0 + 4_001)).toBe(false);
  });

  it("não suprime evento de lead que eu não toquei", () => {
    marcarEcoLocal(LEAD, T0);
    expect(ehEcoLocal(OUTRO, T0 + 10)).toBe(false);
  });

  it("liberar um lead sem marca não cria marca nenhuma", () => {
    // onSettled pode rodar para um lead cuja mutação não marcou eco; isso não
    // pode virar uma marca do nada, senão silencia evento remoto.
    liberarEcoLocal(LEAD, T0);
    expect(ehEcoLocal(LEAD, T0 + 1)).toBe(false);
  });

  it("uma ação nova reabre a janela de um lead já assentado", () => {
    marcarEcoLocal(LEAD, T0);
    liberarEcoLocal(LEAD, T0 + 100);
    marcarEcoLocal(LEAD, T0 + 5_000); // segunda ação, muito depois
    expect(ehEcoLocal(LEAD, T0 + 7_000)).toBe(true);
  });
});
