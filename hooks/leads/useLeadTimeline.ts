"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import type { TimelineItemView } from "@/lib/types/contacts";

/**
 * A timeline do dossiê, viva.
 *
 * ⚠️ **NÃO reuse o eco local do board aqui.** As duas superfícies têm
 * polaridades OPOSTAS pelo mesmo motivo: no card, a própria ação já é visível e
 * repetir seria ruído; na timeline, a própria ação é JUSTAMENTE o que se quer
 * ver registrado. Suprimir o eco aqui faria a atividade que o usuário acabou de
 * gerar sumir para ele — e sumir em silêncio, porque ela FOI gravada.
 *
 * A semelhança é a armadilha: dois usos do mesmo mecanismo com polaridade
 * oposta parecem duplicação para quem lê rápido, e "remover duplicação" é o
 * refactor mais aplaudido que existe.
 */
export interface TimelineAoVivo {
  itens: TimelineItemView[];
  isLoading: boolean;
  isError: boolean;
  /**
   * Ids que chegaram por realtime NESTE mount.
   *
   * Existem porque o colapso e o tempo real se anulam: se o evento novo cai
   * dentro de um bloco já colapsado, a timeline vai de "3 ações" para "4 ações"
   * e o usuário NÃO VÊ O QUE CHEGOU — o requisito de agrupar esconde o que o
   * requisito de tempo real promete mostrar.
   *
   * A saída não é expandir o bloco sozinho (isso mudaria retroativamente o que
   * já está na tela e a pessoa perde onde estava lendo): o que chega fica FORA
   * do agrupamento nesta sessão, e só se junta ao bloco numa abertura nova do
   * dossiê. O que vem de fora tem de ser VISTO, não contado.
   */
  chegouAoVivo: Set<string>;
  realtimeStatus: string;
}

async function fetchTimeline(contactId: string): Promise<TimelineItemView[]> {
  const res = await apiClient.get<{ data: TimelineItemView[] }>(
    `/api/v1/contacts/${contactId}/timeline`,
  );
  if (res && typeof res === "object" && "data" in res) {
    return (res as { data: TimelineItemView[] }).data;
  }
  return res as unknown as TimelineItemView[];
}

/** O id da atividade dentro do payload do postgres_changes. */
function idDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { new?: { id?: unknown } };
  return typeof p.new?.id === "string" ? p.new.id : null;
}

export function useLeadTimeline(contactId: string | null): TimelineAoVivo {
  const qc = useQueryClient();
  const queryKey = ["timeline", contactId] as const;
  const [chegouAoVivo, setChegouAoVivo] = useState<Set<string>>(new Set());
  // `useRef` para o Set não virar dependência do callback e o canal não
  // re-assinar a cada evento — re-assinar perderia eventos na janela.
  const recebidos = useRef<Set<string>>(new Set());

  const query = useQuery({
    queryKey,
    queryFn: () => fetchTimeline(contactId as string),
    enabled: !!contactId,
  });

  const onChange = useCallback(
    (payload: unknown) => {
      qc.invalidateQueries({ queryKey });
      const id = idDoEvento(payload);
      if (!id || recebidos.current.has(id)) return;
      recebidos.current.add(id);
      setChegouAoVivo(new Set(recebidos.current));
    },
    [qc, queryKey],
  );

  // Filtra por `contact_id` porque a timeline é do contato — o mesmo eixo que a
  // rota usa. Filtrar por lead_id deixaria de fora a atividade que nasce da
  // conversa e não de um negócio específico.
  const { status } = useRealtimeChannel({
    name: contactId ? `timeline-${contactId}` : "timeline-disabled",
    postgresChanges: contactId
      ? {
          event: "INSERT",
          schema: "public",
          table: "crm_lead_activities",
          filter: `contact_id=eq.${contactId}`,
        }
      : undefined,
    onChange,
    enabled: !!contactId,
  });

  return {
    itens: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    chegouAoVivo,
    realtimeStatus: status,
  };
}
