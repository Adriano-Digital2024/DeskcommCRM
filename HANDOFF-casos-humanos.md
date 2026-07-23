# HANDOFF — Casos Humanos

> **LEIA no início de cada avanço. ALIMENTE ao fim de cada wave** com: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, o que foi acrescentado, estado atual. Zero progresso invisível.
> Cadência (spec §11.4): back = teste rodado; front = **Playwright clicando de verdade + avaliação de UX/clareza**; front+back = integrado. Quebrou → arruma antes de avançar. Prova de agente/mensageria SÓ em conta/conversa REAL.

- **Spec:** `docs/specs/15-spec-casos-humanos.md`
- **Plano:** `docs/superpowers/plans/2026-07-23-casos-humanos.md`
- **Ledger SDD:** `.superpowers/sdd/progress.md` (seção "CASOS HUMANOS")
- **Execução:** subagent-driven (implementer fresco/task + task review + review final)

## Estado atual
**Waves 1-6 COMPLETAS e revisadas.** Código do épico inteiro no ar: schema, repositório, tools no turno, handler de re-entrada, guardrail, rotas, toggle e UI do atendente. `test:unit` 533/533, `test:db` 234, typecheck/lint 0.
**Próximo: Wave 7 — PROVA E2E do loop completo** (brief: w7-brief.md; base 8b1a906). É a wave que fecha: clicar cada botão no navegador em conta real, provar o loop IA↔humano↔lead e avaliar a experiência.

**3 bugs reais achados e corrigidos pelas reviews** (nenhum apareceria em typecheck/teste comum):
1. Transição de caso e seu efeito não eram atômicos → caso podia ficar travado sem recuperação pela API (`a124444`).
2. `cases_enabled` em 2 de 7 cópias de `VERSION_COLUMNS` → toggle se desmarcava sozinho e revertia o valor no save seguinte (`e698c72`, + teste que trava divergência futura).
3. "Concluí" pré-selecionado no painel → atendente fechava o caso sem querer (`8b1a906`).
**A INVARIANTE CENTRAL (W4) ESTÁ SEGURA** — review opus confirmou: lead nunca recebe promessa-de-humano sem caso aberto (garantia estrutural: fail-safe re-roda a cadeia inteira, zero envio fora dela).
**Nota de execução:** 2 implementers caíram por session limit (W4 1ª tentativa, W5). Ambos retomados sem perda — a W5 estava verde na árvore e foi verificada/commitada pelo controller.
**Decisão de escopo:** need_lead_info NÃO arma cron novo (agente já tem schedule_followup); lead_unresponsive→aviso fica como enhancement documentado.
Minors abertos p/ review FINAL: (a) `revoke all from anon` nas 2 tabelas (forward-fix 0067); (b) 1 skip test:db; (c) doc comment W3b; (d) detector: apertar falsos positivos ("pode te ajudar", "passar o link") — candidato W6; (e) PRÉ-EXISTENTE: doc de before-send cita before-send.test.ts inexistente (cadeia sem snapshot test).

## O que este épico entrega
Sistema de casos/tickets: a IA delega uma tarefa a um humano de retaguarda e **continua dona da conversa** com o lead (loop assíncrono IA↔humano), com garantia dura anti-alucinação (gate que impede a IA de prometer humano sem abrir caso). Novo e **paralelo** ao handoff existente.

## Waves
- [x] **W0** confirmar runtime + HANDOFF
- [x] **W1** schema (migration 0066: agent_cases + agent_case_events + cases_enabled + CHECKs case_reply_turn) — review Approved
- [x] **W2** repositório + tools de dados (open/provide) + JobKind — review Approved
- [x] **W3a** agent-config.casesEnabled + tools open/provide no turno (gated) + bloco de sistema + drop CaseIds.leadId — review Approved
- [x] **W3b** handler case_reply_turn + registro no worker — review Approved
- [x] **W4** guardrail anti-alucinação (fail-safe auto-open; cenários adversariais como asserções) — review OPUS Approved ← requisito crítico SEGURO
- [x] **W5** ativação por agente (cases_enabled) + rotas API + ponte de escalação (performHumanHandoff) — commit 86e7c20, review em curso
- [x] **W6** UI de casos (3 ações estruturadas, rótulos pt-br, timeline traduzida) — review Approved pós-fix
- [ ] **W7** prova E2E do loop completo em conta/conversa REAL + avaliação de UX na tela

## Log
- 2026-07-23 **W0**: runtime confirmado (`AGENT_DISPATCH_CONSUMER`=engine default, .env.example/.env.hostgator.example=engine; `workers/agent-worker/main.ts:188`). Spec/plano corrigidos (string `engine`, não `agent-engine`). Ambiguidades da spec resolvidas nas extrações: handoff canônico = `performHumanHandoff` (human-handoff.ts:149); guardrail = gate novo em before-send.ts; UI = polling 60s (useAgentInbox). Sem código de produção ainda.
