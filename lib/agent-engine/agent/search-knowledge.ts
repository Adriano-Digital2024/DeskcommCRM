/**
 * RAG no turno do engine (Fase 0 da convergência — spec 2026-07-23).
 *
 * Busca top-K na KB publicada do agente via RPC retrieve_top_k_chunks
 * (SECURITY DEFINER + filtro programático de org — o caller passa o org da
 * ROW do job, fonte confiável). Erros viram ensino ao modelo, convenção do
 * harness: { ok:false, error } — nunca exceção.
 */
import type pg from 'pg';

import { embedText } from '@/lib/ai/embed';
import type { Citation } from '@/lib/ai/citations/types';

export interface KnowledgeHit {
  chunk_id: string;
  knowledge_source_id: string | null;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

export type SearchKnowledgeResult =
  | { ok: true; results: KnowledgeHit[] }
  | { ok: false; error: { code: string; message: string } };

export async function searchKnowledge(
  pool: pg.Pool,
  args: { organizationId: string; kbVersionId: string; query: string; topK: number; threshold: number },
  deps?: { embed?: typeof embedText },
): Promise<SearchKnowledgeResult> {
  const embed = deps?.embed ?? embedText;
  let embedding: number[];
  try {
    ({ embedding } = await embed(args.query, { organizationId: args.organizationId }));
  } catch {
    return {
      ok: false,
      error: {
        code: 'knowledge_unavailable',
        message: 'a base de conhecimento está indisponível agora — responda com o que você já sabe e não invente fatos.',
      },
    };
  }
  const vec = `[${embedding.join(',')}]`;
  const { rows } = await pool.query<KnowledgeHit>(
    `select chunk_id, knowledge_source_id, content, similarity, metadata
     from retrieve_top_k_chunks($1, $2, $3::vector, $4, $5)`,
    [args.organizationId, args.kbVersionId, vec, args.topK, args.threshold],
  );
  return { ok: true, results: rows };
}

/** Shape que a UI do inbox já renderiza (CitationsPanel — lib/ai/citations/types). */
export function citationsFromHits(hits: KnowledgeHit[]): Citation[] {
  return hits.map((h) => ({
    chunk_id: h.chunk_id,
    knowledge_source_id: h.knowledge_source_id,
    score: h.similarity,
    snippet: h.content.slice(0, 240),
    ...(h.metadata !== null ? { metadata: h.metadata } : {}),
  }));
}
