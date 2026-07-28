import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  authOk,
  etapa,
  funil,
  makeDb,
  negocio,
} from "../_db-double";

const url = `http://localhost/api/v1/pipelines/${PIPE}/stages/e2`;

function ctx(stageId = "e2") {
  return { params: Promise.resolve({ id: PIPE, stageId }) };
}

function reqPatch(body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function reqDelete(destino?: string) {
  return new NextRequest(destino ? `${url}?destino=${destino}` : url, { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/pipelines/[id]/stages/[stageId]", () => {
  it("sem auth → repassa a resposta do requireRole, sem escrever", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente. Requer role >= manager.", 403, {}),
    });
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento" }), ctx());
    expect(res.status).toBe(403);
    expect(db.escritas).toEqual([]);
  });

  /**
   * O 403 acima mocka o `requireRole` para falhar SEMPRE — passaria igual se a
   * edição pedisse `agent`. Quem prova o papel da escrita é este.
   */
  it("exige manager", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ name: "Orçamento" }), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  /**
   * ⭐ O teste que mais importa. A etapa EXISTE e o id é o certo — só que ela é
   * de outra organização. O dublê aplica o `eq("organization_id", …)` de
   * verdade, então apagar esse filtro da rota faz este teste ficar vermelho.
   */
  it("etapa de outra organização → 404 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({
      stages: funil().map((e) => ({ ...e, organization_id: OUTRA_ORG })),
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento", is_won: true }), ctx());

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("funil de outra organização → 404 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({
      pipelineOrg: OUTRA_ORG,
      stages: funil().map((e) => ({ ...e, organization_id: OUTRA_ORG })),
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento" }), ctx());

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
  });

  /**
   * Mesma organização, OUTRO funil. Sem o `eq("pipeline_id", …)` na leitura, a
   * etapa entraria na lista e o UPDATE (que filtra por funil) casaria zero
   * linhas: 200 alegre e nada gravado — pior do que o 404.
   */
  it("etapa de outro funil da mesma organização → 404 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({
      stages: [
        ...funil(),
        etapa({ id: "x1", name: "Etapa alheia", slug: "alheia", pipeline_id: "outro-funil" }),
      ],
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento" }), ctx("x1"));

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
  });

  it("corpo vazio → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({}), ctx());

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("renomear → um update só, com os filtros de tenant", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento" }), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual({ name: "Orçamento" });
    expect(db.escritas[0]?.filtros).toContainEqual(["id", "e2"]);
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(db.escritas[0]?.filtros).toContainEqual(["pipeline_id", PIPE]);

    // O slug NÃO acompanha o nome: é chave técnica sob índice único.
    expect(db.escritas[0]?.patch).not.toHaveProperty("slug");

    const body = (await res.json()) as { data: { etapas: Array<{ id: string; name: string }> } };
    expect(body.data.etapas.find((e) => e.id === "e2")?.name).toBe("Orçamento");
  });

  it("nome já usado por outra etapa → 422 com a mensagem da regra, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Novo" }), ctx());

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("«Novo»");
    expect(db.escritas).toEqual([]);
  });

  /**
   * ⭐ `uniq_crm_stages_pipeline_won` é imediato: marcar «Proposta» antes de
   * liberar «Pago» é 23505 cru na cara do usuário. As marcas de início/fim do
   * dublê têm folga real — em paralelo os dois `start` sairiam antes do
   * primeiro `end`.
   */
  it("mover a marcação de ganho → dois updates em SEQUÊNCIA, desmarcando primeiro", async () => {
    authOk();
    const stages = funil().map((e) =>
      e.id === "e3" ? { ...e, agent_stage_hint: "won" } : e,
    );
    const db = makeDb({ stages });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ is_won: true }), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas.map((e) => [e.filtros.find(([c]) => c === "id")?.[1], e.patch])).toEqual([
      // O passo do assistente acompanha a marcação: sem isso o CHECK
      // `crm_stages_hint_coerente_com_won_lost` estoura com 23514.
      ["e3", { is_won: false, agent_stage_hint: null }],
      ["e2", { is_won: true, agent_stage_hint: "won" }],
    ]);
    expect(db.eventos).toEqual([
      "start:crm_stages:0",
      "end:crm_stages:0",
      "start:crm_stages:1",
      "end:crm_stages:1",
    ]);
  });

  it("desmarcar o ganho sem substituta → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ is_won: false }), ctx("e3"));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("«Pago»");
    expect(db.escritas).toEqual([]);
  });

  it("reordenar: depois_de calcula a posição entre as vizinhas", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    // «Proposta» (2000) vai para depois de «Pago» (3000), antes de «Cancelado» (4000).
    const res = await PATCH(reqPatch({ depois_de: "e3" }), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual({ position: 3500 });
  });

  it("reordenar para o começo: depois_de null vai antes da primeira", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ depois_de: null }), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas[0]?.patch).toEqual({ position: 0 });
  });

  it("reordenar depois de uma etapa que não existe → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    // Sem a recusa, «não achei a vizinha» viraria «vai para o começo do funil»:
    // a coluna salta para o topo do quadro e ninguém pediu isso.
    const res = await PATCH(reqPatch({ depois_de: "e99" }), ctx());

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("reordenar com vizinhas empatadas → 409, e nenhuma escrita", async () => {
    authOk();
    // `midpoint` devolve NaN com vizinhas de mesma posição; NaN vira `null` no
    // JSON e a coluna é NOT NULL — 23502 cru. Recusa antes de tocar o banco.
    const db = makeDb({
      stages: [
        etapa({ id: "e1", name: "Novo", slug: "novo", position: 1000 }),
        etapa({ id: "e2", name: "Proposta", slug: "proposta", position: 2000 }),
        etapa({ id: "e5", name: "Empate", slug: "empate", position: 1000 }),
      ],
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ depois_de: "e1" }), ctx());

    expect(res.status).toBe(409);
    expect(db.escritas).toEqual([]);
  });

  it("renomear e reordenar juntos → um único update", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento", depois_de: "e3" }), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual({ name: "Orçamento", position: 3500 });
  });

  it("renomear junto com a marcação → o nome viaja no update do alvo, não num terceiro", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Fechado", is_won: true }), ctx());

    expect(res.status).toBe(200);
    // Um terceiro UPDATE no mesmo alvo seria uma segunda ida ao banco sem
    // motivo — e, entre ela e a marcação, uma janela em que o funil está sem
    // etapa de ganho gravada.
    expect(db.escritas.map((e) => [e.filtros.find(([c]) => c === "id")?.[1], e.patch])).toEqual([
      ["e3", { is_won: false }],
      ["e2", { is_won: true, name: "Fechado" }],
    ]);
  });

  it("audita pipeline.stage_updated", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ name: "Orçamento" }), ctx());

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.stage_updated",
        organizationId: ORG_ID,
        resourceType: "crm_stage",
        resourceId: "e2",
      }),
    );
  });

  it("23505 do índice único → 409 em português, sem texto do Postgres", async () => {
    authOk();
    makeDb({
      stages: funil(),
      writeError: (n) =>
        n === 1
          ? {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "uniq_crm_stages_pipeline_won"',
            }
          : null,
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ is_won: true }), ctx());

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.message).toContain("Pago");
    // Sem esta metade, um 500 devolvendo a mensagem crua do Postgres também
    // conteria o nome da etapa e passaria.
    expect(body.error.message).not.toContain("unique");
    expect(body.error.message).not.toContain("constraint");
  });

  it("erro inesperado do banco → 500", async () => {
    authOk();
    makeDb({
      stages: funil(),
      writeError: () => ({ code: "08006", message: "connection failure" }),
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Orçamento" }), ctx());
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/v1/pipelines/[id]/stages/[stageId]", () => {
  it("exige manager", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { DELETE } = await import("./route");
    await DELETE(reqDelete(), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("etapa de outra organização → 404 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({
      stages: funil().map((e) => ({ ...e, organization_id: OUTRA_ORG })),
      leads: [negocio("l1", "e2")],
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete("e1"), ctx());

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("com negócios e sem destino → 422 com a CONTAGEM na mensagem, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({
      stages: funil(),
      leads: [negocio("l1", "e2"), negocio("l2", "e2"), negocio("l3", "e1")],
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    // 2, não 3: o negócio de «Novo» não está nesta etapa.
    expect(body.error.message).toContain("2 negócios");
    expect(body.error.message).toContain("«Proposta»");
    expect(db.escritas).toEqual([]);
  });

  /**
   * ⭐ A ordem inversa deixaria negócio apontando para coluna arquivada se a
   * segunda escrita falhasse.
   */
  it("com destino → move os negócios ANTES de arquivar a etapa", async () => {
    authOk();
    const db = makeDb({
      stages: funil(),
      leads: [negocio("l1", "e2"), negocio("l2", "e2")],
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete("e1"), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas.map((e) => [e.table, e.patch])).toEqual([
      ["crm_leads", { stage_id: "e1" }],
      ["crm_stages", { is_archived: true }],
    ]);
    expect(db.eventos).toEqual([
      "start:crm_leads:0",
      "end:crm_leads:0",
      "start:crm_stages:1",
      "end:crm_stages:1",
    ]);
    // Os negócios andaram de verdade, e só os desta etapa.
    expect(db.tabelas.crm_leads.map((l) => l.stage_id)).toEqual(["e1", "e1"]);
    // O update dos negócios é filtrado por tenant e por etapa de origem.
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(db.escritas[0]?.filtros).toContainEqual(["stage_id", "e2"]);
  });

  it("etapa vazia sem destino → arquiva direto", async () => {
    authOk();
    const db = makeDb({ stages: funil(), leads: [negocio("l1", "e1")] });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas.map((e) => e.table)).toEqual(["crm_stages"]);

    const body = (await res.json()) as { data: { etapas: Array<{ id: string }> } };
    expect(body.data.etapas.map((e) => e.id)).toEqual(["e1", "e3", "e4"]);
  });

  it("etapa de ganho → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete("e1"), ctx("e3"));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("«Pago»");
    expect(db.escritas).toEqual([]);
  });

  it("destino fora do funil → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil(), leads: [negocio("l1", "e2")] });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete("e99"), ctx());

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("audita pipeline.stage_archived com a contagem movida", async () => {
    authOk();
    makeDb({ stages: funil(), leads: [negocio("l1", "e2"), negocio("l2", "e2")] });
    const { DELETE } = await import("./route");
    await DELETE(reqDelete("e1"), ctx());

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.stage_archived",
        organizationId: ORG_ID,
        resourceType: "crm_stage",
        resourceId: "e2",
        metadata: expect.objectContaining({ destino_id: "e1", negocios_movidos: 2 }),
      }),
    );
  });

  /**
   * Se o move dos negócios falha, a etapa NÃO pode ser arquivada: é o inverso
   * exato do defeito que a ordem protege.
   */
  it("falha ao mover os negócios → 500 e a etapa continua no quadro", async () => {
    authOk();
    const db = makeDb({
      stages: funil(),
      leads: [negocio("l1", "e2")],
      writeError: (_n, table) =>
        table === "crm_leads" ? { code: "08006", message: "connection failure" } : null,
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete("e1"), ctx());

    expect(res.status).toBe(500);
    expect(db.escritas.map((e) => e.table)).toEqual(["crm_leads"]);
    expect(db.tabelas.crm_stages.find((e) => e.id === "e2")?.is_archived).toBe(false);
  });
});
