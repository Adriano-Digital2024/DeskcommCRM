"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { consumirEcoLocal } from "@/lib/kanban/local-echo";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import type { BoardData } from "@/lib/kanban/types";

/**
 * Fetch board via API route (NOT direct supabase-js).
 *
 * Why: the auth cookie `sb-deskcomm-auth` is httpOnly so the browser Supabase
 * client cannot read it — auth.uid() ends up null, RLS hides the pipeline,
 * and PostgREST returns PGRST116. Routing through /api/v1/pipelines/[id]/board
 * uses the server-side cookie reader, identical to every other authed query.
 */
async function fetchBoard(pipelineId: string): Promise<BoardData> {
  const res = await apiClient.get<{ data: BoardData }>(
    `/api/v1/pipelines/${pipelineId}/board`,
  );
  // apiClient unwraps { data, meta } envelope already in some helpers;
  // ours returns the parsed JSON literally. Handle both shapes safely.
  if (res && typeof res === "object" && "data" in res) {
    return (res as { data: BoardData }).data;
  }
  return res as unknown as BoardData;
}

/** Quanto tempo o card fica marcado como "acabou de chegar". */
const PULSE_MS = 1_200;

/** O id do lead dentro do payload do postgres_changes (new, ou old no delete). */
function idDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { new?: { id?: unknown }; old?: { id?: unknown } };
  const id = p.new?.id ?? p.old?.id;
  return typeof id === "string" ? id : null;
}

export function useBoard(pipelineId: string | null) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  /**
   * Cards que acabaram de mudar POR EVENTO REMOTO — o pulso da Wave 3.
   *
   * Só entra aqui o que veio de fora: a própria ação já tem feedback (o card se
   * move sob o cursor) e pulsar nela seria ruído com cara de novidade. Cada id
   * sai sozinho depois de PULSE_MS: o pulso acontece UMA vez e cessa, em vez de
   * virar destaque persistente.
   */
  const [pulseIds, setPulseIds] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey,
    queryFn: () => fetchBoard(pipelineId as string),
    enabled: !!pipelineId,
  });

  const onChange = useCallback(
    (payload: unknown) => {
      // Conservative: invalidate the board on any change. Optimistic patches
      // arrive faster via useMoveCard's onMutate; this just reconciles
      // cross-user changes within ~250ms.
      qc.invalidateQueries({ queryKey });

      const leadId = idDoEvento(payload);
      if (!leadId || consumirEcoLocal(leadId)) return;

      setPulseIds((atual) => new Set(atual).add(leadId));
      setTimeout(() => {
        setPulseIds((atual) => {
          if (!atual.has(leadId)) return atual;
          const proximo = new Set(atual);
          proximo.delete(leadId);
          return proximo;
        });
      }, PULSE_MS);
    },
    [qc, queryKey],
  );

  useRealtimeChannel({
    name: pipelineId ? `kanban-${pipelineId}` : "kanban-disabled",
    postgresChanges: pipelineId
      ? {
          event: "*",
          schema: "public",
          table: "crm_leads",
          filter: `pipeline_id=eq.${pipelineId}`,
        }
      : undefined,
    onChange,
    enabled: !!pipelineId,
  });

  return { ...query, pulseIds };
}
