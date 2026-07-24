# HANDOFF — Casos Humanos

> **LEIA no início de cada avanço. ALIMENTE ao fim de cada wave** com: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, o que foi acrescentado, estado atual. Zero progresso invisível.
> Cadência (spec §11.4): back = teste rodado; front = **Playwright clicando de verdade + avaliação de UX/clareza**; front+back = integrado. Quebrou → arruma antes de avançar. Prova de agente/mensageria SÓ em conta/conversa REAL.

- **Spec:** `docs/specs/15-spec-casos-humanos.md`
- **Plano:** `docs/superpowers/plans/2026-07-23-casos-humanos.md`
- **Ledger SDD:** `.superpowers/sdd/progress.md` (seção "CASOS HUMANOS")
- **Execução:** subagent-driven (implementer fresco/task + task review + review final)

## Estado atual
**Waves 1-6 completas e revisadas. Wave 7 (prova E2E) PARCIAL** — interrompida por limite SEMANAL de API (reseta 25/jul 02h). Código todo verde: `test:unit` 533/533, `test:db` 236, typecheck/lint 0.

### O que a prova E2E mostrou (docs/evidence/casos-humanos/, 7 telas, cenário real "assinatura inativa após pagamento", agente anthropic real)
- **PROVADO na tela:** abertura do caso pela IA (summary/blocker escritos pelo agente) · lista com "Aguardando você" · detalhe com blocos rotulados · ação "Preciso de info do cliente" → badge vira "Aguardando o cliente" + painel desabilitado com a razão certa · conclusão → aba "Abertos (0)" + estado vazio. **UX aprovada por mim**: clara, ensina, de-quem-é-a-bola óbvio, 3 ações inequívocas, zero enum cru. O fix do W6 (sem pré-seleção) confirmado ao vivo.
- **NÃO provado ao vivo (re-provar após reset):** etapa C — lead responde → IA chama `provide_case_update` sozinha. No teste, o modelo respondeu ao cliente mas não chamou a tool (faltava o `case_id` no contexto). **Corrigido em código** (`getCaseAwaitingLead`, commit f111c58) mas o re-teste caiu no limite; a prova seguiu com a transição aplicada à mão (documentado honestamente na timeline do caso).
- **NÃO provado:** envio outbound REAL ao lead (WAHA) em cada etapa; escalação ponta-a-ponta (E). Faltou re-rodar.

**5 bugs reais achados e corrigidos** (nenhum apareceria em typecheck/teste com mock — todos de INTERAÇÃO entre waves):
1. Transição de caso + efeito não atômicos → caso travado sem recuperação (`a124444`).
2. `cases_enabled` em 2 de 7 cópias de `VERSION_COLUMNS` → toggle se desmarcava e revertia no save (`e698c72` + teste anti-divergência).
3. "Concluí" pré-selecionado → atendente fechava caso sem querer (`8b1a906`).
4. case-reply-turn descartava a conclusão (checava "aberto", mas W5 já transicionou) → IA nunca repassava ao lead (`f111c58`).
5. provide_case_update inalcançável no caminho comum (modelo sem case_id quando o lead responde) (`f111c58`).

### PRÓXIMO (após reset do limite, 25/jul 02h)
Re-rodar a prova E2E das etapas C/D/E com os fixes aplicados, em conversa REAL (WAHA), provando o envio outbound ao lead. Brief: w7-brief.md.
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
