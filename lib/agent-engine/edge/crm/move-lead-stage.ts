/**
 * Espelho do avanço de funil no kanban do CRM — LIGADO. O harness (lead_state) é
 * a fonte da verdade do funil do agente; quando o agente avança um passo, o card
 * do tenant anda junto no board, traduzido pelo `crm_stages.agent_stage_hint`.
 *
 * ⚠️ Este arquivo NÃO decide qual negócio do contato se move: ele DELEGA para
 * `sincronizaEstagioDoAgente`, que reusa o `resolveActiveLeadForContact` da wave
 * 4. Um segundo resolvedor aqui seriam duas fontes que começam iguais e divergem
 * no primeiro ajuste.
 *
 * ponytail: os três não-movimentos legítimos (sem mapa / sem negócio / ambíguo)
 * viram 'not_configured' de propósito — o caller (inbound-turn) trata esse valor
 * como warn-only, sem inbox nem falha de job.
 */
import { sincronizaEstagioDoAgente } from '@/lib/leads/agent-stage-sync';
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import type { LeadStage } from '../../agent/lead-state';

export type MirrorResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'crm_error' | 'crm_unavailable'; detail: string };

/** Injetável só para teste — em produção é sempre a implementação real. */
interface Deps {
  sync?: typeof sincronizaEstagioDoAgente;
}

export async function mirrorLeadStageToCrm(
  _db: Queryable,
  cfg: CrmEdgeConfig,
  input: { tenantId: string; leadId: string; toStage: LeadStage; reason?: string },
  deps: Deps = {},
): Promise<MirrorResult> {
  const sync = deps.sync ?? sincronizaEstagioDoAgente;
  try {
    // `input.leadId` é o contact_id do CRM: o funil do agente é por CONTATO
    // (lead_state.contact_id) e quem resolve "qual negócio deste contato" é o
    // `resolveActiveLeadForContact` lá dentro — não aqui.
    const r = await sync(cfg.supabase, {
      organizationId: input.tenantId,
      contactId: input.leadId,
      passo: input.toStage,
    });

    if (r.moveu || r.motivo === 'ja_esta_la') return { ok: true };

    // Os três não-movimentos são estados LEGÍTIMOS do produto, e por isso todos
    // caem em `not_configured`: o chamador trata esse valor como warn-only, sem
    // abrir item de inbox. Marcá-los como erro treinaria o usuário a ignorar o
    // inbox — o preço de um alerta que quase sempre não é incidente.
    const detalhe: Record<string, string> = {
      sem_mapeamento: `nenhum estágio do pipeline declara agent_stage_hint = "${input.toStage}"`,
      sem_negocio: 'o contato não tem negócio aberto para mover',
      ambiguo: 'o contato tem mais de um negócio aberto — nenhum foi movido',
    };
    return { ok: false, reason: 'not_configured', detail: detalhe[r.motivo] ?? r.motivo };
  } catch (err) {
    return {
      ok: false,
      reason: 'crm_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
