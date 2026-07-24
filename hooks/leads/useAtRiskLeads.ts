"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RiskBucket } from "@/lib/leads/risk-radar";

export interface AtRiskLead {
  id: string;
  title: string;
  contact_id: string | null;
  contact_name: string | null;
  owner_user_id: string | null;
  assignee_kind: "user" | "ai" | null;
  last_activity_at: string | null;
  hours_since_activity: number;
  risk: RiskBucket;
  in_flight: boolean;
  next_followup_at: string | null;
  conversation_id: string | null;
  pipeline_id: string;
}

export interface AtRiskData {
  items: AtRiskLead[];
  counts: { critico: number; em_risco: number; em_voo: number };
  total: number;
}

/** Radar de risco (C1). Polling 60s — a atividade dos leads muda no worker/inbox. */
export function useAtRiskLeads() {
  return useQuery({
    queryKey: ["leads-at-risk"],
    refetchInterval: 60_000,
    queryFn: () =>
      apiClient.get<{ data: AtRiskData }>(`/api/v1/leads/at-risk`).then((r) => r.data),
  });
}
