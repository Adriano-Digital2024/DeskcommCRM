import { beforeEach, describe, expect, it } from "vitest";

import { ehEcoLocal, limparEcosLocais, marcarEcoLocal } from "@/lib/kanban/local-echo";

const LEAD = "11111111-1111-4111-8111-111111111111";
const OUTRO = "22222222-2222-4222-8222-222222222222";

describe("eco local do pulso", () => {
  beforeEach(() => limparEcosLocais());

  it("suprime TODAS as escritas da mesma ação, não só a primeira", () => {
    // O caso que quebrou (12.c): arrastar um card produz duas escritas na
    // linha — `stage_id` na rota e `last_activity_at` 112ms depois, quando a
    // atividade `stage_changed` entra. A versão antiga consumia a marca na
    // primeira e a aba que agiu pulsava na segunda.
    const t0 = 1_000_000;
    marcarEcoLocal(LEAD, t0);
    expect(ehEcoLocal(LEAD, t0 + 60)).toBe(true); // movimento
    expect(ehEcoLocal(LEAD, t0 + 172)).toBe(true); // carimbo da atividade
    expect(ehEcoLocal(LEAD, t0 + 400)).toBe(true); // qualquer derivada seguinte
  });

  it("deixa de suprimir quando a janela vence", () => {
    const t0 = 1_000_000;
    marcarEcoLocal(LEAD, t0);
    expect(ehEcoLocal(LEAD, t0 + 2_000)).toBe(true);
    expect(ehEcoLocal(LEAD, t0 + 2_001)).toBe(false);
  });

  it("não suprime evento de lead que eu não toquei", () => {
    marcarEcoLocal(LEAD, 1_000_000);
    expect(ehEcoLocal(OUTRO, 1_000_010)).toBe(false);
  });

  it("uma marca vencida não silencia o evento seguinte do mesmo lead", () => {
    // Polaridade declarada no módulo: o pior caso é um pulso a mais, nunca um
    // evento remoto engolido. Marca velha vira lixo e some.
    const t0 = 1_000_000;
    marcarEcoLocal(LEAD, t0);
    expect(ehEcoLocal(LEAD, t0 + 5_000)).toBe(false);
    expect(ehEcoLocal(LEAD, t0 + 5_001)).toBe(false);
  });

  it("uma ação nova renova a janela", () => {
    const t0 = 1_000_000;
    marcarEcoLocal(LEAD, t0);
    marcarEcoLocal(LEAD, t0 + 1_500);
    expect(ehEcoLocal(LEAD, t0 + 3_000)).toBe(true);
  });
});
