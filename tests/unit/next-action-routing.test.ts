import { describe, expect, it } from "vitest";

import { roteiaProximasAcoes, type EstadoDoContato } from "@/lib/leads/next-action";
import type { LeadCandidate } from "@/lib/leads/active-lead";

const ORG = "00000000-0000-4000-8000-000000000001";
const CONTATO = "00000000-0000-4000-8000-0000000000c1";
const OUTRO_CONTATO = "00000000-0000-4000-8000-0000000000c2";
const PIPE_A = "00000000-0000-4000-8000-0000000000a1";
const PIPE_B = "00000000-0000-4000-8000-0000000000b1";

type Cand = LeadCandidate & { contact_id: string | null };

function lead(id: string, over: Partial<Cand> = {}): Cand {
  return {
    id,
    organization_id: ORG,
    pipeline_id: PIPE_A,
    status: "open",
    last_activity_at: "2026-07-20T10:00:00Z",
    created_at: "2026-07-01T10:00:00Z",
    contact_id: CONTATO,
    ...over,
  };
}

const proposta: EstadoDoContato = {
  contact_id: CONTATO,
  next_action: "ligar para o Carlos amanhã",
  updated_at: "2026-07-24T19:48:12Z",
};

describe("roteamento da próxima ação (contato → negócio)", () => {
  it("um único negócio aberto recebe a proposta", () => {
    const mapa = roteiaProximasAcoes([proposta], [lead("L1")]);
    expect(mapa.get("L1")?.label).toBe("ligar para o Carlos amanhã");
    expect(mapa.size).toBe(1);
  });

  it("dois negócios ambíguos: NÃO aparece em nenhum", () => {
    // Uma ação, dois botões seria pior que nenhum botão: aprovar num executaria
    // pelo outro. A polaridade é a mesma de resolveActiveLeadForContact.
    const mapa = roteiaProximasAcoes(
      [proposta],
      [lead("L1"), lead("L2")], // mesmo last_activity_at → empate
    );
    expect(mapa.size).toBe(0);
  });

  it("dois abertos com atividades diferentes: vai para o mais recente", () => {
    const mapa = roteiaProximasAcoes(
      [proposta],
      [lead("L1"), lead("L2", { last_activity_at: "2026-07-24T10:00:00Z" })],
    );
    expect(mapa.get("L2")?.label).toBe("ligar para o Carlos amanhã");
    expect(mapa.has("L1")).toBe(false);
  });

  it("a lista precisa vir da ORG, não do pipeline aberto na tela", () => {
    // A armadilha silenciosa: com os candidatos recortados por pipeline, cada
    // board veria UM negócio do contato e mostraria a proposta como se fosse
    // dele — dois cards, em telas diferentes, com o mesmo botão.
    const doPipelineA = [lead("L1")];
    expect(roteiaProximasAcoes([proposta], doPipelineA).size).toBe(1); // visão recortada: roteia

    const daOrgInteira = [lead("L1"), lead("L2", { pipeline_id: PIPE_B })];
    expect(roteiaProximasAcoes([proposta], daOrgInteira).size).toBe(0); // visão real: ambíguo
  });

  it("negócio fechado não recebe proposta", () => {
    const mapa = roteiaProximasAcoes([proposta], [lead("L1", { status: "won" })]);
    expect(mapa.size).toBe(0);
  });

  it("proposta vazia ou só espaços não vira slot", () => {
    for (const texto of ["", "   ", null]) {
      const mapa = roteiaProximasAcoes(
        [{ ...proposta, next_action: texto }],
        [lead("L1")],
      );
      expect(mapa.size).toBe(0);
    }
  });

  it("estado de um contato não vaza para o negócio de outro", () => {
    const mapa = roteiaProximasAcoes(
      [proposta],
      [lead("L1", { contact_id: OUTRO_CONTATO })],
    );
    expect(mapa.size).toBe(0);
  });

  it("lead sem contato é ignorado sem quebrar o resto", () => {
    const mapa = roteiaProximasAcoes([proposta], [lead("L0", { contact_id: null }), lead("L1")]);
    expect(mapa.get("L1")?.label).toBe("ligar para o Carlos amanhã");
  });

  it("o texto proposto viaja junto, para a trava comparar o que foi LIDO", () => {
    const mapa = roteiaProximasAcoes([proposta], [lead("L1")]);
    expect(mapa.get("L1")?.approved_text).toBe("ligar para o Carlos amanhã");
    expect(mapa.get("L1")?.proposed_at).toBe("2026-07-24T19:48:12Z");
  });
});
