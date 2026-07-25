/**
 * Canonical Lead shape returned by the `/api/v1/leads/*` endpoints.
 * Mirrors `crm_leads` columns (Spec 04 §schema). Status transitions go through
 * the DB trigger `fn_crm_lead_close_on_stage` — the API never sets `status`
 * directly (P-02).
 */
export type LeadStatus = "open" | "won" | "lost";

/**
 * 0070 — o dono do negócio é humano ou agente de IA (mesmo padrão de
 * `conversations.assignee_kind`, 0032). `null` = sem dono.
 */
export type OwnerKind = "user" | "ai" | null;

/**
 * Identidade do agente dono, resolvida no servidor e anexada ao lead pela rota
 * do board. **Não é coluna** de `crm_leads`.
 *
 * Por que viaja com o lead em vez de sair de uma lista de agentes: "quem PODE
 * receber um lead" (picker — só agente ativo) e "quem É o dono deste lead"
 * (exibição — qualquer agente, inclusive desativado ou arquivado) são perguntas
 * diferentes. Resolver a segunda pela primeira faz o dono ficar anônimo no dia
 * em que alguém desativa o agente.
 */
export interface LeadOwnerAgent {
  id: string;
  name: string;
  /** Versão publicada no momento da leitura — nunca congelada no lead. */
  version_number: number | null;
}

export interface Lead {
  id: string;
  organization_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  title: string;
  description: string | null;
  status: LeadStatus;
  lost_reason: string | null;
  position_in_stage: number;
  value_cents: number | null;
  currency: string | null;
  owner_user_id: string | null;
  /** 0070: quem é dono do negócio — humano, agente de IA, ou ninguém. */
  owner_kind: OwnerKind;
  /** 0070: identidade do agente dono (ai_agents.id), nunca a versão. */
  owner_agent_id: string | null;
  /** Derivado (não é coluna): quem é o agente dono — ver LeadOwnerAgent. */
  owner_agent?: LeadOwnerAgent | null;
  /**
   * Derivado (não é coluna): a próxima ação que o agente propôs para o CONTATO,
   * já roteada para o negócio ativo dele. Ver lib/leads/next-action.ts — só
   * aparece quando o roteamento é inequívoco.
   */
  next_action?: { label: string; seq: number; proposed_at: string } | null;
  assigned_at: string | null;
  last_activity_at: string | null;
  expected_close_date: string | null;
  closed_at: string | null;
  source: string;
  source_metadata: Record<string, unknown>;
  external_id: string | null;
  custom_fields: Record<string, unknown>;
  tags: string[];
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
}
