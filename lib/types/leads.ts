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
