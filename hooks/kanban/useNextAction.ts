"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";

interface DecidirArgs {
  leadId: string;
  decision: "approve" | "dismiss";
  /** O texto que estava NA TELA — a trava do servidor compara com este. */
  approvedText: string;
}

/**
 * A decisão humana sobre a próxima ação proposta pelo agente.
 *
 * Manda o texto que a pessoa leu, não um id: se o agente reescreveu a proposta
 * entre o render e o clique, o servidor recusa com 409 em vez de executar a
 * proposta nova em nome de quem autorizou a antiga.
 */
export function useDecidirProximaAcao(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  return useMutation({
    mutationFn: async ({ leadId, decision, approvedText }: DecidirArgs) => {
      // Decidir muda o lead (a atividade carimba `last_activity_at`), então é
      // eco local como qualquer outra mutação — senão o card pulsa na cara de
      // quem acabou de clicar.
      marcarEcoLocal(leadId);
      return apiClient.post<{ data: { lead_id: string; decision: string } }>(
        `/api/v1/leads/${leadId}/next-action`,
        { decision, approved_text: approvedText },
      );
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        // A proposta mudou (ou sumiu): recarregar é o que mostra a nova.
        qc.invalidateQueries({ queryKey });
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      liberarEcoLocal(args.leadId);
      qc.invalidateQueries({ queryKey });
    },
  });
}
