"use client";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgentMapping,
  useSaveAgentMapping,
  type EtapaDoFunil,
  type MapaDoAgente,
} from "@/hooks/pipelines/useAgentMapping";
import { LEAD_STAGES, type LeadStage } from "@/lib/agent-engine/agent/lead-state";
import { ApiError } from "@/lib/api/types";
import { ROTULO_DO_PASSO } from "@/lib/leads/agent-mapping";
import { ArrowRight, Warning } from "@/lib/ui/icons";

/**
 * Onde o dono do negócio diz ao agente para onde levar o card em cada momento do
 * atendimento.
 *
 * ⚠️ A TELA INVERTE O BANCO, DE PROPÓSITO. `crm_stages.agent_stage_hint` guarda
 * etapa → passo; aqui é uma linha por PASSO, na ordem em que o cliente avança,
 * escolhendo a etapa. É o modelo mental de quem configura ("quando o agente
 * qualificar, mova para…") e torna impossível pedir dois destinos para o mesmo
 * passo — o formulário não tem como expressar isso.
 *
 * ⚠️ O ÍNDICE ÚNICO DO BANCO VIRA AUSÊNCIA, NÃO ERRO. Etapa já escolhida por
 * outro passo simplesmente não aparece nas demais listas; o mesmo vale para a
 * coerência com ganho/perda (CHECK da 0084). A recusa da API continua existindo
 * para a tela desatualizada — mas o caminho normal nunca a alcança.
 *
 * ⚠️ «NÃO MOVER» É ESCOLHA, NÃO PENDÊNCIA (migration 0084, com todas as letras).
 * Nada nesta tela marca esse estado como erro, incompleto ou faltando.
 */

/** Sentinela do «não mover»: o Radix Select proíbe item com valor vazio. */
const SEM_ETAPA = "__sem_etapa__";

/**
 * Quando cada passo acontece, em linguagem de quem atende — não é uma segunda
 * tradução do nome (esse vem inteiro de `ROTULO_DO_PASSO`, fonte única), é a
 * explicação que responde "e quando é isso?" sem obrigar o dono da clínica a
 * adivinhar o vocabulário de CRM.
 */
const QUANDO_ACONTECE: Readonly<Record<LeadStage, string>> = {
  new: "a pessoa acabou de chamar e ninguém respondeu ainda",
  contacted: "o agente já respondeu pela primeira vez",
  qualifying: "o agente está entendendo o que a pessoa precisa",
  qualified: "o agente já entendeu a necessidade",
  negotiating: "conversa de preço, proposta ou agendamento",
  won: "a pessoa fechou",
  lost: "a pessoa desistiu ou parou de responder",
};

/**
 * As etapas que este passo pode receber — a regra da API escrita como ausência.
 *
 * Três filtros, e cada um evita um erro DIFERENTE que o banco devolveria:
 *  • etapa já escolhida por outro passo → índice único `uniq_crm_stages_pipeline_hint`;
 *  • «Ganho»/«Perdido» só em etapa de fechamento/perda → CHECK da 0084;
 *  • os outros cinco passos NUNCA em etapa de fechamento/perda → o mesmo CHECK,
 *    no sentido inverso (uma etapa de ganho só pode representar «Ganho»).
 */
export function opcoesDoPasso(
  passo: LeadStage,
  etapas: EtapaDoFunil[],
  mapa: MapaDoAgente,
): EtapaDoFunil[] {
  const ocupadasPorOutros = new Set(
    LEAD_STAGES.filter((p) => p !== passo)
      .map((p) => mapa[p])
      .filter((id): id is string => id !== null),
  );
  return etapas.filter((e) => {
    if (ocupadasPorOutros.has(e.id)) return false;
    if (passo === "won") return e.is_won;
    if (passo === "lost") return e.is_lost;
    return !e.is_won && !e.is_lost;
  });
}

/**
 * Por que a lista está vazia — lista vazia muda é o pior desfecho possível:
 * o usuário conclui que a tela está quebrada.
 *
 * As duas causas pedem respostas opostas. "Não existe etapa de fechamento neste
 * funil" é um fato sobre o funil, e não há tela no produto que marque etapa de
 * ganho/perda (isso vem de quem montou o funil) — prometer um link seria mentir.
 * "As outras já estão em uso" é reversível aqui mesmo, e o texto diz como.
 */
export function motivoDaListaVazia(passo: LeadStage, etapas: EtapaDoFunil[]): string {
  if (passo === "won" && !etapas.some((e) => e.is_won)) {
    return "Este funil não tem nenhuma etapa marcada como fechamento, então não há para onde levar o card quando a pessoa fecha. Quem montou o funil precisa marcar a etapa de ganho.";
  }
  if (passo === "lost" && !etapas.some((e) => e.is_lost)) {
    return "Este funil não tem nenhuma etapa marcada como perda, então não há para onde levar o card quando a pessoa desiste. Quem montou o funil precisa marcar a etapa de perda.";
  }
  return "Todas as etapas deste funil já estão sendo usadas por outros passos. Libere uma delas acima para poder escolhê-la aqui.";
}

function iguais(a: MapaDoAgente, b: MapaDoAgente): boolean {
  return LEAD_STAGES.every((p) => a[p] === b[p]);
}

export function AgentMappingSection({ pipelineId }: { pipelineId: string }) {
  const consulta = useAgentMapping(pipelineId);
  const salvar = useSaveAgentMapping(pipelineId);
  const [rascunho, setRascunho] = useState<MapaDoAgente | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const ultimaLeitura = useRef(0);

  // ⚠️ TODA LEITURA NOVA DO SERVIDOR SUBSTITUI O RASCUNHO — inclusive a releitura
  // que o erro dispara. É o que impede o usuário de reenviar sobre um funil que
  // mudou embaixo dele: sem isto, o segundo envio grava por cima da decisão de
  // outra pessoa e ninguém fica sabendo. `dataUpdatedAt` e não a referência de
  // `data`: o react-query preserva a referência quando o conteúdo volta igual, e
  // aí o rascunho velho sobreviveria justamente ao caso que motivou a releitura.
  const { data, dataUpdatedAt } = consulta;
  useEffect(() => {
    if (!data || dataUpdatedAt === ultimaLeitura.current) return;
    ultimaLeitura.current = dataUpdatedAt;
    setRascunho(data.mapeamento);
  }, [data, dataUpdatedAt]);

  if (consulta.isError) {
    return (
      <p className="text-sm text-text-muted" data-testid="mapeamento-erro-leitura">
        Não foi possível carregar as etapas deste funil agora. Recarregue a página.
      </p>
    );
  }
  if (!data || !rascunho) {
    return (
      <p className="text-sm text-text-muted" data-testid="mapeamento-carregando">
        Carregando as etapas deste funil…
      </p>
    );
  }

  const etapas = data.etapas;
  const mudou = !iguais(rascunho, data.mapeamento);
  const gravando = salvar.isPending || consulta.isFetching;

  function escolher(passo: LeadStage, valor: string) {
    setErro(null);
    setRascunho((atual) =>
      atual ? { ...atual, [passo]: valor === SEM_ETAPA ? null : valor } : atual,
    );
  }

  function enviar() {
    if (!rascunho) return;
    setErro(null);
    // Os SETE passos, sempre — `null` explícito é "não mover", e a rota recusa
    // corpo parcial com 422.
    salvar.mutate(rascunho, {
      onError: (e) => {
        setErro(
          e instanceof ApiError
            ? e.message
            : "Não deu para salvar agora. Confira sua conexão e tente de novo.",
        );
      },
    });
  }

  return (
    <div className="space-y-4" data-testid={`mapeamento-${pipelineId}`}>
      <div className="space-y-1">
        {/* "O funil do agente" seria o nome óbvio e é o errado: a página inteira
            se chama Funis e trata dos funis do tenant. Duas coisas diferentes
            com o mesmo nome, na mesma tela, fazem o dono da clínica procurar um
            segundo funil que não existe. O título diz o que a seção FAZ. */}
        <h3 className="text-sm font-semibold">Para onde o card vai em cada passo</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          Quando o agente avança no atendimento, o card do cliente pode andar sozinho no seu
          funil. Escolha para qual etapa ele vai em cada momento. Deixar em «não mover» é uma
          escolha válida — o card fica onde está e o agente segue trabalhando.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {LEAD_STAGES.map((passo) => {
          const opcoes = opcoesDoPasso(passo, etapas, rascunho);
          // A etapa já escolhida some das opções DOS OUTROS passos, nunca das
          // suas — por isso lista vazia implica escolha nenhuma, e o Select
          // nunca fica com um valor sem rótulo.
          const escolhida = rascunho[passo];
          return (
            <li
              key={passo}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4"
              data-testid={`passo-${passo}`}
            >
              <div className="min-w-0 sm:w-64">
                <p className="text-sm font-medium">{ROTULO_DO_PASSO[passo]}</p>
                <p className="text-xs text-text-muted">{QUANDO_ACONTECE[passo]}</p>
              </div>
              <ArrowRight
                size={16}
                className="hidden shrink-0 text-text-muted sm:block"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                {opcoes.length === 0 ? (
                  <p className="text-xs leading-relaxed text-text-muted" data-testid={`vazio-${passo}`}>
                    {motivoDaListaVazia(passo, etapas)}
                  </p>
                ) : (
                  <Select
                    value={escolhida ?? SEM_ETAPA}
                    onValueChange={(v) => escolher(passo, v)}
                  >
                    <SelectTrigger
                      aria-label={`Etapa para «${ROTULO_DO_PASSO[passo]}»`}
                      data-testid={`etapa-${passo}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_ETAPA}>Não mover o card</SelectItem>
                      {opcoes.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {erro && (
        <Card
          className="flex items-start gap-3 border-warning bg-warning-bg p-4"
          data-testid="mapeamento-erro"
        >
          <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
          <p className="text-sm leading-relaxed">
            {erro} As escolhas voltaram para o que está gravado agora — confira e escolha de
            novo.
          </p>
        </Card>
      )}

      <div className="flex items-center justify-end gap-3">
        {salvar.isSuccess && !mudou && !erro && (
          <span className="text-xs text-text-muted" data-testid="mapeamento-salvo">
            Escolhas salvas.
          </span>
        )}
        <Button onClick={enviar} disabled={!mudou || gravando} data-testid="salvar-mapeamento">
          {gravando ? "Salvando…" : "Salvar estas escolhas"}
        </Button>
      </div>
    </div>
  );
}
