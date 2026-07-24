/**
 * 0070 — resolução do dono do negócio (humano | agente | ninguém).
 * Fonte única do card, do filtro e (waves 5-7) do dossiê e do radar.
 */
import { describe, it, expect } from "vitest";

import { resolveLeadOwner } from "./owner";
import type { AssignableAgent } from "@/hooks/kanban/useAssignableAgents";

const agents = new Map<string, AssignableAgent>([
  ["ag-1", { agent_id: "ag-1", name: "Agente Beta", version_number: 3, is_active: true }],
  [
    "ag-2",
    { agent_id: "ag-2", name: "Agente Sem Versão", version_number: null, is_active: true },
  ],
  // Desligado, mas ainda dono de negócios: o card precisa saber o nome dele.
  ["ag-off", { agent_id: "ag-off", name: "Bot Aposentado", version_number: 9, is_active: false }],
]);
const humans = new Map<string, string | null>([["u-1", "Maria Silva"]]);

const lead = (over: Partial<Parameters<typeof resolveLeadOwner>[0]>) => ({
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  ...over,
});

describe("resolveLeadOwner", () => {
  it("dono humano", () => {
    expect(
      resolveLeadOwner(lead({ owner_kind: "user", owner_user_id: "u-1" }), humans, agents),
    ).toEqual({ kind: "user", name: "Maria Silva", agentVersion: null });
  });

  it("dono agente traz a versão publicada de hoje", () => {
    expect(
      resolveLeadOwner(lead({ owner_kind: "ai", owner_agent_id: "ag-1" }), humans, agents),
    ).toEqual({ kind: "ai", name: "Agente Beta", agentVersion: 3 });
  });

  it("agente sem versão publicada não inventa versão", () => {
    expect(
      resolveLeadOwner(lead({ owner_kind: "ai", owner_agent_id: "ag-2" }), humans, agents),
    ).toEqual({ kind: "ai", name: "Agente Sem Versão", agentVersion: null });
  });

  it("agente DESATIVADO que ainda é dono continua nomeado no card", () => {
    expect(
      resolveLeadOwner(lead({ owner_kind: "ai", owner_agent_id: "ag-off" }), humans, agents),
    ).toEqual({ kind: "ai", name: "Bot Aposentado", agentVersion: 9 });
  });

  it("sem dono", () => {
    expect(resolveLeadOwner(lead({}), humans, agents)).toEqual({
      kind: null,
      name: null,
      agentVersion: null,
    });
  });

  it("dono cujo nome ainda não carregou continua sendo dono (não vira órfão)", () => {
    expect(
      resolveLeadOwner(lead({ owner_kind: "ai", owner_agent_id: "ag-desconhecido" }), humans, agents),
    ).toEqual({ kind: "ai", name: null, agentVersion: null });
    expect(
      resolveLeadOwner(lead({ owner_kind: "user", owner_user_id: "u-99" }), humans, agents),
    ).toEqual({ kind: "user", name: null, agentVersion: null });
  });

  it("banco pré-0070: owner_user_id sem owner_kind ainda mostra o humano", () => {
    expect(resolveLeadOwner(lead({ owner_user_id: "u-1" }), humans, agents)).toEqual({
      kind: "user",
      name: "Maria Silva",
      agentVersion: null,
    });
  });

  it("mapas ausentes não quebram a resolução", () => {
    expect(
      resolveLeadOwner(lead({ owner_kind: "ai", owner_agent_id: "ag-1" }), undefined, undefined),
    ).toEqual({ kind: "ai", name: null, agentVersion: null });
  });
});
