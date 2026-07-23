/**
 * Wave 5 (spec 15 §7/§9) — rotas de casos humanos.
 *
 * GET /api/v1/ai/cases: filtro por status + org-scope + role gate ≥agent.
 * POST /api/v1/ai/cases/:id/reply: matriz de transição (need_lead_info,
 * escalate), 409 em caso terminal, 404 org-scoped (isolamento).
 *
 * As transições do repositório + enqueueJob + performHumanHandoff rodam sobre
 * pg.Pool (mundo do engine) — aqui mockados como spies; a leitura do caso
 * dentro da rota também roda no pool mockado (stub de `.query()`). O fluxo
 * REAL contra Postgres (job_queue CHECK, RLS, o handler case_reply_turn
 * consumindo o job) fica para o E2E da Wave 6 — não fabricado aqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/agent/human-cases", () => ({
  resolveCaseFromHuman: vi.fn(async () => undefined),
  markAwaitingLead: vi.fn(async () => undefined),
  escalateCase: vi.fn(async () => undefined),
  buildCaseSummary: vi.fn((row: { title: string }) => `resumo: ${row.title}`),
}));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  performHumanHandoff: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-engine/queue/queue", () => ({
  enqueueJob: vi.fn(async () => ({ job: { id: "job-1" }, deduped: false })),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";

function session(effectiveRole: Role) {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: effectiveRole }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[effectiveRole] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: effectiveRole } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/v1/ai/cases
// ---------------------------------------------------------------------------

describe("GET /api/v1/ai/cases", () => {
  function makeAdminStub(rows: Array<Record<string, unknown>>) {
    const calls: { eqCalls: Array<[string, unknown]>; inCalls: Array<[string, unknown]> } = {
      eqCalls: [],
      inCalls: [],
    };
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        calls.eqCalls.push([col, val]);
        return chain;
      },
      in: (col: string, val: unknown) => {
        calls.inCalls.push([col, val]);
        return chain;
      },
      order: () => Promise.resolve({ data: rows, error: null }),
      then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onF),
    };
    return { from: () => chain, __calls: calls };
  }

  it("viewer é barrado (403 forbidden_role), sem chegar a consultar o banco", async () => {
    session("viewer");
    const admin = makeAdminStub([]);
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);
    const { GET } = await import("@/app/api/v1/ai/cases/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/cases?status=open"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_role");
  });

  it("status=open filtra por organization_id + status abertos", async () => {
    session("agent");
    const rows = [
      {
        id: CASE_ID,
        title: "Desconto especial",
        summary: "Cliente quer 20%",
        blocker: "Alçada",
        status: "awaiting_human",
        opened_at: "2026-07-23T10:00:00Z",
        conversation_id: CONV_ID,
        conversations: { contacts: { name: "Fulano", phone_number: "+55119" } },
      },
    ];
    const admin = makeAdminStub(rows);
    vi.mocked(createAdminClient).mockReturnValue(admin as unknown as ReturnType<typeof createAdminClient>);
    const { GET } = await import("@/app/api/v1/ai/cases/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/cases?status=open"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { cases: Array<{ id: string; contact_name: string | null }>; open_count: number };
    };
    expect(body.data.cases).toHaveLength(1);
    expect(body.data.cases[0]?.contact_name).toBe("Fulano");
    expect(admin.__calls.eqCalls.some(([col, val]) => col === "organization_id" && val === ORG_ID)).toBe(
      true,
    );
    expect(
      admin.__calls.inCalls.some(
        ([col, val]) => col === "status" && Array.isArray(val) && val.includes("awaiting_human"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/ai/cases/:id/reply
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/cases/:id/reply", () => {
  function makePoolStub(caseRow: Record<string, unknown> | undefined) {
    return { query: vi.fn(async () => ({ rows: caseRow ? [caseRow] : [] })) };
  }

  function caseRowFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      status: "awaiting_human",
      title: "Desconto especial",
      summary: "Cliente quer 20%",
      blocker: "Alçada",
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      ...overrides,
    };
  }

  function replyReq(body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("need_lead_info: transiciona awaiting_human->awaiting_lead, enfileira case_reply_turn, audita", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture());
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { markAwaitingLead } = await import("@/lib/agent-engine/agent/human-cases");
    const { enqueueJob } = await import("@/lib/agent-engine/queue/queue");

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "need_lead_info", body: "Qual o CPF do cliente?" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { data: { status: string } };
    expect(resBody.data.status).toBe("awaiting_lead");

    expect(vi.mocked(markAwaitingLead)).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      CASE_ID,
      USER_ID,
      "Qual o CPF do cliente?",
    );
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      expect.objectContaining({
        kind: "case_reply_turn",
        leadId: CONTACT_ID,
        payload: expect.objectContaining({ case_id: CASE_ID, action: "need_lead_info" }),
      }),
    );
    expect(
      vi.mocked(audit).mock.calls.some(
        ([e]) => e.action === "ai.case_replied" && e.metadata?.case_action === "need_lead_info",
      ),
    ).toBe(true);
  });

  it("escalate: chama escalateCase + performHumanHandoff com ids resolvidos do caso", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture());
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { escalateCase, buildCaseSummary } = await import("@/lib/agent-engine/agent/human-cases");
    const { performHumanHandoff } = await import("@/lib/agent-engine/agent/human-handoff");

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "escalate", body: "Fora do playbook, precisa de humano" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { data: { status: string } };
    expect(resBody.data.status).toBe("escalated");

    expect(vi.mocked(escalateCase)).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      CASE_ID,
      USER_ID,
      "Fora do playbook, precisa de humano",
    );
    expect(vi.mocked(buildCaseSummary)).toHaveBeenCalled();
    expect(vi.mocked(performHumanHandoff)).toHaveBeenCalledWith(
      pool,
      { tenantId: ORG_ID, leadId: CONTACT_ID, conversationId: CONV_ID },
      expect.objectContaining({ reason: "Fora do playbook, precisa de humano" }),
    );
  });

  it("caso terminal (resolved) → 409 invalid_state, sem transição/enqueue/handoff", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture({ status: "resolved" }));
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { resolveCaseFromHuman } = await import("@/lib/agent-engine/agent/human-cases");
    const { enqueueJob } = await import("@/lib/agent-engine/queue/queue");

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "resolved", body: "Já resolvido antes" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_state");
    expect(vi.mocked(resolveCaseFromHuman)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it("caso de outra org → 404 (org resolvida via authz, nunca do body/path)", async () => {
    session("agent");
    // A leitura do caso é org-scoped: para uma org sem esse caso, o SELECT
    // (WHERE organization_id = $1 AND id = $2) não retorna linha — mesmo
    // efeito de o caso pertencer a OTHER_ORG_ID.
    const pool = makePoolStub(undefined);
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "resolved", body: "tentando de outra org" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    // Prova que a query foi org-scoped pelo org do authz (ORG_ID), não OTHER_ORG_ID.
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [ORG_ID, CASE_ID]);
  });
});
