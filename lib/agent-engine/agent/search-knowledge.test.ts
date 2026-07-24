import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

// search-knowledge importa lib/ai/embed → lib/env, que valida env no import.
// O CI roda sem .env; o teste injeta seu próprio `embed`, então mockar env
// evita a validação real (mesmo padrão de dispatcher-external-mode.test.ts).
vi.mock('@/lib/env', () => ({ env: {} }));

import { citationsFromHits, searchKnowledge } from './search-knowledge';

const hit = {
  chunk_id: 'c1', knowledge_source_id: 's1',
  content: 'Frete grátis acima de R$ 199.', similarity: 0.91, metadata: { source_type: 'faq' },
};

describe('searchKnowledge', () => {
  it('embeda a query e devolve os hits da RPC', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [hit] });
    const embed = vi.fn().mockResolvedValue({ embedding: [0.1, 0.2], promptTokens: 3, model: 'm' });
    const out = await searchKnowledge(
      { query } as unknown as pg.Pool,
      { organizationId: 'org1', kbVersionId: 'kb1', query: 'frete', topK: 5, threshold: 0.72 },
      { embed },
    );
    expect(out).toEqual({ ok: true, results: [hit] });
    expect(embed).toHaveBeenCalledWith('frete', { organizationId: 'org1' });
    // embedding vai à RPC como literal pgvector '[0.1,0.2]'
    expect(query.mock.calls[0]?.[1]).toEqual(['org1', 'kb1', '[0.1,0.2]', 5, 0.72]);
  });

  it('erro de embedding vira erro de ENSINO, nunca exceção', async () => {
    const embed = vi.fn().mockRejectedValue(new Error('embed_unavailable: no key'));
    const out = await searchKnowledge(
      { query: vi.fn() } as unknown as pg.Pool,
      { organizationId: 'org1', kbVersionId: 'kb1', query: 'frete', topK: 5, threshold: 0.72 },
      { embed },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('knowledge_unavailable');
  });

  it('erro de RPC (pool.query) vira erro de ENSINO, nunca exceção', async () => {
    const query = vi.fn().mockRejectedValue(new Error('rpc_error: pgvector dimension mismatch'));
    const embed = vi.fn().mockResolvedValue({ embedding: [0.1, 0.2], promptTokens: 3, model: 'm' });
    const out = await searchKnowledge(
      { query } as unknown as pg.Pool,
      { organizationId: 'org1', kbVersionId: 'kb1', query: 'frete', topK: 5, threshold: 0.72 },
      { embed },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('knowledge_unavailable');
      expect(out.error.message).toContain('indisponível');
    }
  });
});

describe('citationsFromHits', () => {
  it('mapeia hit para o shape Citation da UI (snippet truncado, score)', () => {
    const citations = citationsFromHits([{ ...hit, content: 'x'.repeat(500) }]);
    expect(citations).toHaveLength(1);
    const c = citations[0]!;
    expect(c).toMatchObject({ chunk_id: 'c1', knowledge_source_id: 's1', score: 0.91 });
    expect((c.snippet ?? '').length).toBeLessThanOrEqual(240);
  });
});
