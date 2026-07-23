# HANDOFF — Épico Evolução do Harness

> LEIA no início de toda sessão. ALIMENTE ao fim de cada task: progresso, testes rodados, bugs achados/corrigidos, o que ficou pra trás, estado atual.

**Spec:** docs/superpowers/specs/2026-07-23-harness-evolution-design.md
**Plano da fase atual:** docs/superpowers/plans/2026-07-23-harness-fase0-convergencia.md

## Estado atual
- Fase 0 iniciada. Task 1 concluída (2026-07-23 08:19).

## Log
- 2026-07-23 — Task 1 concluída: PublishedAgentConfig expõe KB ativa e knobs de RAG (activeKbVersionId, ragTopK, ragSimilarityThreshold). Testes: 3/3 verde (campos RAG, defaults, null). Typecheck zerado. Pronta pra Task 2 (retrieval setup).
- 2026-07-23 — Task 2 concluída: lib/agent-engine/agent/search-knowledge.ts (searchKnowledge + citationsFromHits), 3/3 testes verdes; commit extra necessário no vitest.setup (loader de .env p/ import-time env validation).
- 2026-07-23 — Task 3 concluída: tool `search_knowledge` cabeada no turno (inbound-turn.ts) — def estática em AGENT_TOOL_DEFS, execute com searchKnowledge/citationsFromHits, gate pós-montagem (só entra com activeKbVersionId), citações anexadas em messages.metadata na outbound 'sent'. Achado: READ_ONLY_TOOLS morava em inbound-turn.ts, não em tool-breaker.ts como o brief assumia — movido pra tool-breaker.ts (config do breaker, mais coeso) por decisão do coordenador. Testes: 11/11 verdes (lib/agent-engine), typecheck e lint zerados.
