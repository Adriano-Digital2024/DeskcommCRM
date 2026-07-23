# HANDOFF — Casos Humanos

> **LEIA no início de cada avanço. ALIMENTE ao fim de cada wave** com: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, o que foi acrescentado, estado atual. Zero progresso invisível.
> Cadência (spec §11.4): back = teste rodado; front = **Playwright clicando de verdade + avaliação de UX/clareza**; front+back = integrado. Quebrou → arruma antes de avançar. Prova de agente/mensageria SÓ em conta/conversa REAL.

- **Spec:** `docs/specs/15-spec-casos-humanos.md`
- **Plano:** `docs/superpowers/plans/2026-07-23-casos-humanos.md`
- **Ledger SDD:** `.superpowers/sdd/progress.md` (seção "CASOS HUMANOS")
- **Execução:** subagent-driven (implementer fresco/task + task review + review final)

## Estado atual
**Wave 0 COMPLETA.** Runtime de produção confirmado = **agent-engine** (`AGENT_DISPATCH_CONSUMER` default `'engine'`). Premissa da spec validada. **Próximo: Wave 1 — schema (migration 0064 + baseline + MANIFEST).**

## O que este épico entrega
Sistema de casos/tickets: a IA delega uma tarefa a um humano de retaguarda e **continua dona da conversa** com o lead (loop assíncrono IA↔humano), com garantia dura anti-alucinação (gate que impede a IA de prometer humano sem abrir caso). Novo e **paralelo** ao handoff existente.

## Waves
- [x] **W0** confirmar runtime + HANDOFF
- [ ] **W1** schema (agent_cases + agent_case_events + cases_enabled + CHECKs case_reply_turn)
- [ ] **W2** repositório + tools de dados (open/provide) + JobKind
- [ ] **W3** registro das tools no turno + handler case_reply_turn
- [ ] **W4** guardrail anti-alucinação (fail-safe auto-open) + goldens adversariais ← requisito crítico
- [ ] **W5** ativação por agente (cases_enabled) + rotas API + ponte de escalação (performHumanHandoff)
- [ ] **W6** UI de casos (3 ações estruturadas) + E2E do loop completo em conta real

## Log
- 2026-07-23 **W0**: runtime confirmado (`AGENT_DISPATCH_CONSUMER`=engine default, .env.example/.env.hostgator.example=engine; `workers/agent-worker/main.ts:188`). Spec/plano corrigidos (string `engine`, não `agent-engine`). Ambiguidades da spec resolvidas nas extrações: handoff canônico = `performHumanHandoff` (human-handoff.ts:149); guardrail = gate novo em before-send.ts; UI = polling 60s (useAgentInbox). Sem código de produção ainda.
