/**
 * Resolvedor do turno do Intent Router (Fase 3 — Task 4): decide QUAL agente
 * atende o turno — sticky → classificação → fallback → genérico. Task 5
 * (inbound-turn) consome `TurnAgentResolution` no lugar da chamada direta a
 * `loadPublishedAgentConfig` por channel_session.
 *
 * Regra de decisão (spec 2026-07-23, decisões do Rafael 2026-07-26):
 *   1. sem router ativo pra sessão ⇒ fluxo atual intacto (config por sessão).
 *   2. sticky ativo (router.sticky + stickyAgentId ainda membro do router):
 *      classifica MESMO ASSIM (barato, é o que detecta troca de assunto) —
 *      só troca se a intenção vier DIFERENTE da sticky E confiança >= min;
 *      senão mantém o agente sticky.
 *   3. sem sticky: classifica; intenção não-nula + confiança >= min ⇒ agente
 *      do membro.
 *   4. classificador falhou (null) ⇒ fallback se houver, outcome sempre
 *      'classifier_failed' (falha de classificação é uma categoria própria,
 *      distinta de "classificou e não bateu" — ver task-4-report.md).
 *   5. sem match / confiança baixa ⇒ fallback se houver (outcome 'fallback'),
 *      senão config:null + outcome 'no_match' ⇒ turno responde com o agente
 *      GENÉRICO (decisão do Rafael — não é silêncio).
 *   6. signal null (follow-up, sem mensagem inbound) ⇒ nunca classifica:
 *      sticky se houver, senão fallback, senão genérico.
 *
 * Robustez: qualquer erro inesperado no branch do router (DB fora do ar,
 * shape quebrado) NUNCA derruba o turno — cai no `loadPublishedAgentConfig`
 * de hoje (sem router) com outcome 'classifier_failed' + log.warn. Um lead
 * real está esperando resposta; o router é estritamente aditivo.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { LlmEdgeConfig } from '../edge/llm/run-model-call';
import { loadActiveRouter } from './router-config';
import {
  loadPublishedAgentConfig,
  loadPublishedAgentConfigById,
  type PublishedAgentConfig,
} from './agent-config';
import { classifyIntent } from './intent-classifier';

export interface TurnAgentResolution {
  config: PublishedAgentConfig | null; // null ⇒ turno segue no genérico (comportamento atual)
  routerId: string | null;
  intentName: string | null;
  confidence: number | null;
  outcome: 'no_router' | 'classified' | 'sticky' | 'reclassified' | 'fallback' | 'no_match' | 'classifier_failed';
}

export interface ResolveTurnAgentDeps {
  log: Logger;
  loadActiveRouter?: typeof loadActiveRouter;
  loadPublishedAgentConfigById?: typeof loadPublishedAgentConfigById;
  loadPublishedAgentConfig?: typeof loadPublishedAgentConfig;
  classifyIntent?: typeof classifyIntent;
}

export async function resolveTurnAgent(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    jobId: string;
    channelSessionId: string;
    conversationId: string;
    signal: string | null;
    stickyAgentId: string | null;
    stickyIntent: string | null;
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const _loadActiveRouter = deps.loadActiveRouter ?? loadActiveRouter;
  const _loadAgentById = deps.loadPublishedAgentConfigById ?? loadPublishedAgentConfigById;
  const _loadAgentBySession = deps.loadPublishedAgentConfig ?? loadPublishedAgentConfig;
  const _classifyIntent = deps.classifyIntent ?? classifyIntent;

  try {
    const router = await _loadActiveRouter(db, input.tenantId, input.channelSessionId);
    if (router === null) {
      return {
        config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
        routerId: null,
        intentName: null,
        confidence: null,
        outcome: 'no_router',
      };
    }

    // fallback do router ou genérico — usado pelas regras 4, 5 e 6.
    const resolveFallback = async (
      outcome: 'no_match' | 'classifier_failed',
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      if (router.fallbackAgentId === null) {
        return { config: null, routerId: router.id, intentName: null, confidence, outcome };
      }
      return {
        config: await _loadAgentById(db, input.tenantId, router.fallbackAgentId),
        routerId: router.id,
        intentName: null,
        confidence,
        outcome: outcome === 'classifier_failed' ? 'classifier_failed' : 'fallback',
      };
    };

    // sticky elegível: config liga sticky E o agente ainda é membro do router
    // (membro removido ⇒ trata como sem sticky, decisão segura — ver report).
    const stickyMember =
      router.sticky && input.stickyAgentId !== null
        ? router.members.find((m) => m.agentId === input.stickyAgentId)
        : undefined;

    // regra 6: sem mensagem inbound (follow-up) — nunca classifica.
    if (input.signal === null) {
      if (stickyMember !== undefined) {
        return {
          config: await _loadAgentById(db, input.tenantId, stickyMember.agentId),
          routerId: router.id,
          intentName: input.stickyIntent,
          confidence: null,
          outcome: 'sticky',
        };
      }
      return resolveFallback('no_match', null);
    }

    // classifica — inclusive com sticky ativo, pra detectar troca de assunto (regra 2).
    const verdict = await _classifyIntent(
      db,
      llmCfg,
      { tenantId: input.tenantId, leadId: input.leadId, jobId: input.jobId, router, signal: input.signal },
      { log: deps.log },
    );

    if (verdict === null) {
      return resolveFallback('classifier_failed', null);
    }

    if (stickyMember !== undefined) {
      const changedSubject =
        verdict.intentName !== null && verdict.intentName !== input.stickyIntent && verdict.confidence >= router.minConfidence;
      if (!changedSubject) {
        return {
          config: await _loadAgentById(db, input.tenantId, stickyMember.agentId),
          routerId: router.id,
          intentName: input.stickyIntent,
          confidence: verdict.confidence,
          outcome: 'sticky',
        };
      }
      const newMember = router.members.find((m) => m.intentName === verdict.intentName);
      // newMember sempre definido: classifyIntent só devolve intentName que bateu em router.members.
      return {
        config: await _loadAgentById(db, input.tenantId, newMember!.agentId),
        routerId: router.id,
        intentName: verdict.intentName,
        confidence: verdict.confidence,
        outcome: 'reclassified',
      };
    }

    // sem sticky (regra 3).
    if (verdict.intentName !== null && verdict.confidence >= router.minConfidence) {
      const member = router.members.find((m) => m.intentName === verdict.intentName);
      return {
        config: await _loadAgentById(db, input.tenantId, member!.agentId),
        routerId: router.id,
        intentName: verdict.intentName,
        confidence: verdict.confidence,
        outcome: 'classified',
      };
    }

    return resolveFallback('no_match', verdict.confidence);
  } catch (err) {
    deps.log.warn('resolve-turn-agent: erro inesperado no router — turno cai no fluxo sem router', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: 'classifier_failed',
    };
  }
}
