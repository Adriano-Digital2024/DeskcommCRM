# HANDOFF — Casos Humanos

> **LEIA no início de cada avanço. ALIMENTE ao fim de cada wave** com: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, o que foi acrescentado, estado atual. Zero progresso invisível.
> Cadência (spec §11.4): back = teste rodado; front = **Playwright clicando de verdade + avaliação de UX/clareza**; front+back = integrado. Quebrou → arruma antes de avançar. Prova de agente/mensageria SÓ em conta/conversa REAL.

- **Spec:** `docs/specs/15-spec-casos-humanos.md`
- **Plano:** `docs/superpowers/plans/2026-07-23-casos-humanos.md`
- **Ledger SDD:** `.superpowers/sdd/progress.md` (seção "CASOS HUMANOS")
- **Execução:** subagent-driven (implementer fresco/task + task review + review final)

## Estado atual
**Wave 3b COMPLETA** (review Approved). Handler `case_reply_turn` no worker; re-entrada do humano (resolved/need_lead_info) resolve a conversa DO CASO; no-op seguro p/ caso terminal/inexistente/action inválida. **Próximo: Wave 4 — guardrail anti-alucinação (fail-safe auto-open)** — REQUISITO CRÍTICO. Brief pronto: w4-brief.md. Base: 284b3ca (+ commit do HANDOFF).
**Plano ajustado:** W3=3a+3b (feito). W5 = UI toggle + rotas + escalação (+ arming de follow-up no awaiting_lead — refinar ao chegar). W6 = UI + E2E.
Minors abertos p/ review FINAL: (a) falta `revoke all from anon` nas 2 tabelas (não exploitável; forward-fix 0067); (b) 1 skip no test:db; (c) W3b doc comment cosmético (buildFollowupOpeningMessage não exportada).

## O que este épico entrega
Sistema de casos/tickets: a IA delega uma tarefa a um humano de retaguarda e **continua dona da conversa** com o lead (loop assíncrono IA↔humano), com garantia dura anti-alucinação (gate que impede a IA de prometer humano sem abrir caso). Novo e **paralelo** ao handoff existente.

## Waves
- [x] **W0** confirmar runtime + HANDOFF
- [x] **W1** schema (migration 0066: agent_cases + agent_case_events + cases_enabled + CHECKs case_reply_turn) — review Approved
- [x] **W2** repositório + tools de dados (open/provide) + JobKind — review Approved
- [x] **W3a** agent-config.casesEnabled + tools open/provide no turno (gated) + bloco de sistema + drop CaseIds.leadId — review Approved
- [x] **W3b** handler case_reply_turn + registro no worker — review Approved
- [ ] **W4** guardrail anti-alucinação (fail-safe auto-open) + goldens adversariais ← requisito crítico
- [ ] **W5** ativação por agente (cases_enabled) + rotas API + ponte de escalação (performHumanHandoff)
- [ ] **W6** UI de casos (3 ações estruturadas) + E2E do loop completo em conta real

## Log
- 2026-07-23 **W0**: runtime confirmado (`AGENT_DISPATCH_CONSUMER`=engine default, .env.example/.env.hostgator.example=engine; `workers/agent-worker/main.ts:188`). Spec/plano corrigidos (string `engine`, não `agent-engine`). Ambiguidades da spec resolvidas nas extrações: handoff canônico = `performHumanHandoff` (human-handoff.ts:149); guardrail = gate novo em before-send.ts; UI = polling 60s (useAgentInbox). Sem código de produção ainda.
