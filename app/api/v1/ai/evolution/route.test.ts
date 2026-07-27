import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const requireRole = vi.fn();
vi.mock('@/lib/auth/require-role', () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));

const from = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from }) }));

import { GET } from './route';
import { NextRequest } from 'next/server';

function req(qs = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/ai/evolution${qs}`);
}

/** O que o fake registra de CADA consulta, para as asserções de filtro. */
interface Espiao {
  eq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  lte: Array<[string, unknown]>;
  tabelas: string[];
}

/**
 * Encadeamento do query builder do Supabase: tudo devolve `this`, o await resolve.
 *
 * `head: true` devolve `data: null` + `count`, como o PostgREST de verdade. Sem
 * isso o fake entregaria as linhas nas duas formas e um `data.length` passaria
 * por uma contagem — o teste concordaria com o defeito em vez de medi-lo.
 */
function fakeDb(
  porTabela: Record<string, unknown[]> = {},
  erros: Record<string, string> = {},
): Espiao {
  const espiao: Espiao = { eq: [], gte: [], lte: [], tabelas: [] };
  from.mockImplementation((tabela: string) => {
    espiao.tabelas.push(tabela);
    const rows = porTabela[tabela] ?? [];
    let head = false;
    const b: Record<string, unknown> = {};
    for (const m of ['not', 'order', 'limit', 'in']) b[m] = () => b;
    b.select = (_colunas: string, opts?: { head?: boolean }) => {
      head = opts?.head === true;
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      espiao.eq.push([col, val]);
      return b;
    };
    b.gte = (col: string, val: unknown) => {
      espiao.gte.push([col, val]);
      return b;
    };
    b.lte = (col: string, val: unknown) => {
      espiao.lte.push([col, val]);
      return b;
    };
    b.then = (resolve: (v: unknown) => void) =>
      resolve(
        erros[tabela]
          ? { data: null, count: null, error: { message: erros[tabela] } }
          : { data: head ? null : rows, count: rows.length, error: null },
      );
    return b;
  });
  return espiao;
}

beforeEach(() => {
  requireRole.mockReset();
  from.mockReset();
  requireRole.mockResolvedValue({ ok: true, org: { orgId: 'org-1' } });
  fakeDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/ai/evolution', () => {
  it('recusa quem não é manager', async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response('nao', { status: 403 }) });
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it('recusa intervalo malformado com 422', async () => {
    const r = await GET(req('?from=ontem'));
    expect(r.status).toBe(422);
  });

  it('devolve o payload agregado sem double-nest', async () => {
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    expect(r.status).toBe(200);
    const body = await r.json();
    // `ok()` já envelopa em { data } — um `data.data` aqui é o bug de double-nest.
    expect(body.data.range).toEqual({ from: '2026-07-01', to: '2026-07-03' });
    expect(body.data.data).toBeUndefined();
    expect(body.data.gaps).toBeDefined();
  });

  it('toda consulta filtra a organização do JWT', async () => {
    const espiao = fakeDb();
    await GET(req('?from=2026-07-01&to=2026-07-03'));

    const orgFilters = espiao.eq.filter(([c]) => c === 'organization_id');
    expect(orgFilters.length).toBeGreaterThan(0);
    expect(orgFilters.every(([, v]) => v === 'org-1')).toBe(true);
    // Nenhuma tabela pode ser lida sem o filtro de org: uma consulta a mais que
    // filtros de org significa exatamente uma leitura de tenant aberta.
    expect(orgFilters.length).toBe(espiao.tabelas.length);
  });

  it('toda leitura por data usa o MESMO intervalo do range devolvido', async () => {
    // Contadores contam TUDO que a rota entrega; as séries só cobrem os dias do
    // range. Buscar fora da janela some do gráfico e permanece no card.
    const espiao = fakeDb();
    await GET(req('?from=2026-07-01&to=2026-07-03'));

    expect(espiao.gte.length).toBeGreaterThan(0);
    expect(espiao.gte.every(([, v]) => v === '2026-07-01T00:00:00.000Z')).toBe(true);
    expect(espiao.lte.every(([, v]) => v === '2026-07-03T23:59:59.999Z')).toBe(true);
    // Uma leitura de evento sem janela infla o card em relação ao gráfico.
    expect(espiao.gte.length).toBe(espiao.lte.length);
  });

  it('soma o custo como número mesmo quando o driver entrega numeric como string', async () => {
    // `cost_cents` é `numeric`; um `+` sobre strings concatena em silêncio
    // ('12.5' + '30.25' = '12.530.25' → NaN depois, ou pior, texto no JSON).
    fakeDb({ llm_calls: [{ cost_cents: '12.5' }, { cost_cents: '30.25' }, { cost_cents: null }] });
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();
    expect(body.data.outcome.cost_cents).toBe(42.75);
  });

  it('deriva a taxa de handoff da contagem, não do tamanho da página lida', async () => {
    fakeDb({
      messages: [{}, {}, {}, {}],
      event_log: [{}],
    });
    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    const body = await r.json();
    expect(body.data.outcome.handoff_rate).toBe(0.25);
  });

  it('uma fonte fora do ar zera o bloco dela e nomeia tabela + requestId no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeDb(
      { skill_activations: [{ created_at: '2026-07-02T10:00:00.000Z', skill_name: 'a' }] },
      { org_memory_entries: 'relation down' },
    );

    const r = await GET(req('?from=2026-07-01&to=2026-07-03'));
    expect(r.status).toBe(200);
    const body = await r.json();

    // O bloco da fonte quebrada zera; os outros continuam contando a história.
    expect(body.data.learned.memory_entries).toBe(0);
    expect(body.data.activity.by_skill).toEqual({ a: 1 });

    const chamada = warn.mock.calls.find((c) => String(c[0]).includes('org_memory_entries'));
    expect(chamada, 'a tabela que falhou precisa aparecer no log').toBeDefined();
    expect(JSON.stringify(chamada![1])).toContain(r.headers.get('X-Request-Id'));
  });
});
