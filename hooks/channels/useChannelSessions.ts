"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface ChannelSession {
  id: string;
  provider: string;
  waha_session_name: string;
  display_name: string | null;
  phone_number: string | null;
  status: string;
  status_reason: string | null;
  last_health_check_at: string | null;
  last_status_change_at: string | null;
  daily_message_limit: number;
  is_warmup_complete: boolean | null;
  created_at: string;
  meta_phone_number_id: string | null;
  meta_waba_id: string | null;
}

export type ConnectionHealth = "connected" | "connecting" | "down" | "none";

/**
 * Lista os canais WhatsApp (channel_sessions) da org ativa. Fonte única
 * para o seletor do inbox, o sinal de saúde da sidebar e a Central de Conexões.
 */
export function useChannelSessions(opts?: { refetchInterval?: number; enabled?: boolean }) {
  return useQuery({
    queryKey: ["channel-sessions"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: ChannelSession[] }>("/api/v1/channel-sessions");
      return res.data;
    },
    staleTime: 15_000,
    refetchInterval: opts?.refetchInterval,
    enabled: opts?.enabled ?? true,
  });
}

/**
 * Saúde agregada: vermelho vence (um número caído é o que o usuário precisa
 * ver na hora), depois amarelo (conectando), senão verde (tudo WORKING).
 */
export function deriveOverallHealth(sessions: ChannelSession[] | undefined): ConnectionHealth {
  if (!sessions || sessions.length === 0) return "none";
  if (sessions.some((s) => s.status === "FAILED" || s.status === "STOPPED")) return "down";
  if (sessions.some((s) => s.status === "STARTING" || s.status === "SCAN_QR_CODE")) return "connecting";
  return "connected";
}
