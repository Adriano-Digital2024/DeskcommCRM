"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgentMapping,
  type EtapaDoFunil,
  type MapaDoAgente,
} from "@/hooks/pipelines/useAgentMapping";
import {
  useArquivarEtapa,
  useCriarEtapa,
  useEditarEtapa,
  type PatchDeEtapa,
} from "@/hooks/pipelines/useStages";
import { LEAD_STAGES, type LeadStage } from "@/lib/agent-engine/agent/lead-state";
import { ApiError } from "@/lib/api/types";
import { ROTULO_DO_PASSO } from "@/lib/leads/agent-mapping";
import { Archive, CaretDown, CaretUp, Plus, Warning } from "@/lib/ui/icons";

import { mensagemDeErro } from "./_mapping";

/**
 * Onde o dono do negócio transforma o funil que veio de fábrica no funil dele.
 *
 * ⚠️ ESTA TELA EXISTE PORQUE O SISTEMA JÁ DECIDE POR QUEM INSTALA. O gatilho
 * `trg_seed_default_pipeline_for_org` semeia um funil de e-commerce em TODA
 * organização criada — uma clínica abre o produto e vê "Carrinho abandonado",
 * "Aguardando pagamento", "Em separacao". Até aqui não havia tela, rota nem
 * action que renomeasse, criasse ou tirasse uma etapa do quadro.
 *
 * ⚠️ AS REGRAS SÃO DA API; AQUI SÓ HÁ REFLEXO. Nada nesta tela recalcula o que
 * `lib/leads/stage-editing.ts` já decide — quando a operação é impossível, quem
 * diz é o servidor, e a frase dele (escrita para leigo, citando o nome da etapa)
 * vai inteira para a tela. O que a tela faz por conta própria é só o que ela
 * pode saber antes de perguntar: não OFERECER um destino que a API recusaria
 * (etapa de fechamento ou de perda receberia negócios e os daria por encerrados)
 * e avisar ANTES que marcar o fechamento aqui o tira de lá.
 *
 * ⚠️ ARQUIVAR É O ÚNICO "REMOVER" QUE EXISTE, e não é eufemismo:
 * `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT` — o histórico dos negócios
 * aponta para a etapa e apagá-la levaria o histórico junto.
 */

/** A âncora desta seção. O mapeamento linka para cá quando aponta uma lacuna do funil. */
export const ancoraDasEtapas = (pipelineId: string) => `etapas-${pipelineId}`;

/** O papel de uma etapa no desfecho do negócio. `nenhum` é a maioria das colunas. */
export type Papel = "nenhum" | "won" | "lost";

/**
 * ⚠️ OS RÓTULOS SÓ FAZEM SENTIDO SOB O CABEÇALHO DA COLUNA («O que acontece
 * nesta coluna»), e é assim que foram escritos. A primeira versão dizia
 * «Nenhuma das duas» — correto em relação ao parágrafo do topo, e ilegível na
 * linha: um seletor solto dizendo "nenhuma das duas" faz o dono da clínica
 * perguntar "das duas o quê?". Se o cabeçalho sair, estes textos saem junto.
 */
const ROTULO_DO_PAPEL: Readonly<Record<Papel, string>> = {
  nenhum: "Nada especial",
  won: "Aqui o cliente fecha",
  lost: "Aqui o cliente desiste",
};

export function papelDaEtapa(etapa: EtapaDoFunil): Papel {
  if (etapa.is_won) return "won";
  if (etapa.is_lost) return "lost";
  return "nenhum";
}

/**
 * O papel escolhido traduzido no corpo do PATCH.
 *
 * ⚠️ SÓ O QUE MUDA VIAJA. Mandar `is_lost: false` numa etapa que já não é de
 * perda faria a API validar uma desmarcação que ninguém pediu — e ela recusa
 * desmarcação (o funil precisa de uma etapa de perda). O campo do papel que a
 * etapa ABANDONA entra de propósito: sem ele, virar a etapa de perda em etapa de
 * fechamento pediria "ganho e perda ao mesmo tempo".
 */
export function patchDePapel(etapa: EtapaDoFunil, papel: Papel): PatchDeEtapa {
  const patch: PatchDeEtapa = {};
  const querWon = papel === "won";
  const querLost = papel === "lost";
  if (etapa.is_won !== querWon) patch.is_won = querWon;
  if (etapa.is_lost !== querLost) patch.is_lost = querLost;
  return patch;
}

/**
 * As etapas que podem receber os negócios de uma que está sendo arquivada.
 *
 * ⚠️ FECHAMENTO E PERDA FICAM DE FORA, e o motivo é grave o bastante para não
 * ser detalhe de lista: `fn_crm_lead_close_on_stage` fecha o negócio pelo
 * estágio. Mandar N negócios para a etapa de fechamento os marcaria como
 * vendidos, com data de fechamento — receita mexida por alguém arrumando o
 * quadro. A API recusa; a tela nem oferece, porque oferecer é convidar ao erro.
 */
export function destinosPossiveis(etapas: EtapaDoFunil[], etapaId: string): EtapaDoFunil[] {
  return etapas.filter((e) => e.id !== etapaId && !e.is_won && !e.is_lost);
}

/**
 * O vizinho da ESQUERDA depois de mover a etapa uma casa (`null` = primeira coluna).
 *
 * É o que o PATCH espera: quem clica na seta sabe onde a coluna vai parar, não
 * qual fração de `position` isso vira. Subir uma casa é "passar a ficar depois
 * de quem estava DUAS casas atrás" — daí o `i - 2`.
 */
export function vizinhoAoMover(
  etapas: EtapaDoFunil[],
  i: number,
  direcao: "subir" | "descer",
): string | null {
  if (direcao === "subir") return etapas[i - 2]?.id ?? null;
  return etapas[i + 1]?.id ?? null;
}

/** Passo do assistente que cada etapa representa — `mapeamento` do avesso. */
function passoPorEtapa(mapa: MapaDoAgente): Map<string, LeadStage> {
  const m = new Map<string, LeadStage>();
  for (const passo of LEAD_STAGES) {
    const id = mapa[passo];
    if (id) m.set(id, passo);
  }
  return m;
}

/** O 422 do arquivamento carrega a contagem exata; a frase é do servidor, o número é daqui. */
function negociosDoErro(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  const n = (e.details as { negocios?: unknown } | undefined)?.negocios;
  return typeof n === "number" ? n : null;
}

/** O que o painel de arquivamento está esperando do usuário. */
type Arquivamento = {
  etapaId: string;
  /** `null` enquanto a tela ainda não perguntou ao servidor quantos negócios há. */
  negocios: number | null;
  destino: string | null;
  erro: string | null;
};

export function StagesSection({
  pipelineId,
  ancoraMapeamento,
}: {
  pipelineId: string;
  /** Para onde mandar quem precisa desfazer o vínculo de uma etapa com o assistente. */
  ancoraMapeamento: string;
}) {
  const consulta = useAgentMapping(pipelineId);
  const criar = useCriarEtapa(pipelineId);
  const editar = useEditarEtapa(pipelineId);
  const arquivar = useArquivarEtapa(pipelineId);

  const [erro, setErro] = useState<{ etapaId: string | null; texto: string } | null>(null);
  const [confirmacao, setConfirmacao] = useState<{ etapaId: string; papel: Papel; texto: string } | null>(null);
  const [arquivamento, setArquivamento] = useState<Arquivamento | null>(null);
  const [nova, setNova] = useState<string | null>(null);

  if (consulta.isError) {
    return (
      <p className="text-sm text-text-muted" data-testid="etapas-erro-leitura">
        Não foi possível carregar as etapas deste funil agora. Recarregue a página.
      </p>
    );
  }
  if (!consulta.data) {
    return (
      <p className="text-sm text-text-muted" data-testid="etapas-carregando">
        Carregando as etapas deste funil…
      </p>
    );
  }

  const etapas = consulta.data.etapas;
  const passos = passoPorEtapa(consulta.data.mapeamento);
  const ocupado = criar.isPending || editar.isPending || arquivar.isPending || consulta.isFetching;

  function aplicar(etapaId: string, patch: PatchDeEtapa) {
    if (Object.keys(patch).length === 0) return;
    setErro(null);
    setConfirmacao(null);
    editar.mutate(
      { stageId: etapaId, patch },
      {
        onSuccess: () => toast.success("Etapa atualizada."),
        onError: (e) => setErro({ etapaId, texto: mensagemDeErro(e) }),
      },
    );
  }

  function escolherPapel(etapa: EtapaDoFunil, papel: Papel) {
    const patch = patchDePapel(etapa, papel);
    if (Object.keys(patch).length === 0) return;

    // ⚠️ O AVISO CITA A ETAPA QUE PERDE A MARCAÇÃO, e é a única informação que
    // importa aqui: "só uma pode" é regra abstrata; «Pago» é a coluna que vai
    // deixar de fechar negócio quando ele confirmar.
    const atual = etapas.find((e) => e.id !== etapa.id && (papel === "won" ? e.is_won : e.is_lost));
    if ((papel === "won" || papel === "lost") && atual) {
      setErro(null);
      setConfirmacao({
        etapaId: etapa.id,
        papel,
        texto:
          papel === "won"
            ? `Só uma etapa pode ser a de fechamento. Marcar esta desmarca «${atual.name}».`
            : `Só uma etapa pode ser a de perda. Marcar esta desmarca «${atual.name}».`,
      });
      return;
    }
    aplicar(etapa.id, patch);
  }

  function pedirArquivamento(etapa: EtapaDoFunil, destino: string | null) {
    setErro(null);
    arquivar.mutate(
      { stageId: etapa.id, destinoId: destino },
      {
        onSuccess: () => {
          setArquivamento(null);
          toast.success(`«${etapa.name}» saiu do quadro.`);
        },
        onError: (e) => {
          const negocios = negociosDoErro(e);
          // Negócios parados na etapa não é recusa final: é a pergunta "para
          // onde eles vão?" — e ela só pode ser feita com o número na mão.
          const perguntaDestino =
            negocios !== null &&
            negocios > 0 &&
            !etapa.is_won &&
            !etapa.is_lost &&
            destino === null;
          setArquivamento({
            etapaId: etapa.id,
            negocios,
            destino: null,
            erro: perguntaDestino ? null : mensagemDeErro(e),
          });
        },
      },
    );
  }

  function criarEtapa() {
    const nome = (nova ?? "").trim();
    if (!nome) return;
    setErro(null);
    criar.mutate(nome, {
      onSuccess: () => {
        setNova(null);
        toast.success(`«${nome}» entrou no fim do funil.`);
      },
      onError: (e) => setErro({ etapaId: null, texto: mensagemDeErro(e) }),
    });
  }

  return (
    <div className="space-y-4" id={ancoraDasEtapas(pipelineId)} data-testid={`etapas-${pipelineId}`}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Etapas deste funil</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          Estas são as colunas do seu quadro, na ordem em que o cliente avança. Você pode
          renomear, criar, reordenar e arquivar.
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          Duas colunas têm papel especial: a <strong>de fechamento</strong> é onde o negócio
          vira venda, e a <strong>de perda</strong> é onde ele se perde. Cada funil tem uma de
          cada — por isso a marcação se muda de lugar, não se apaga.
        </p>
      </div>

      {/* ⚠️ O CABEÇALHO NÃO É ENFEITE. Sem ele a linha tem um campo de texto sem
          rótulo, duas setas sem legenda e um seletor dizendo "Nada especial"
          sobre coisa nenhuma — a dona da clínica precisa adivinhar o que cada
          controle faz. Some no celular (`sm:`), onde a linha empilha e cada
          controle já vem com o próprio rótulo acessível. */}
      {/* `border border-transparent`: a lista abaixo tem borda de 1px, que empurra
          o conteúdo dela 1px para dentro. Sem a mesma borda aqui, cada rótulo
          fica 1px à direita do controle que nomeia — medido, não estimado. */}
      <div className="hidden gap-3 border border-transparent px-4 text-xs font-medium text-text-muted sm:flex">
        <span className="w-6 shrink-0" />
        <span className="min-w-0 flex-1">Nome da coluna (clique para renomear)</span>
        <span className="w-[76px] shrink-0 text-center">Ordem</span>
        <span className="w-56 shrink-0">O que acontece nesta coluna</span>
        <span className="w-[104px] shrink-0" />
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {etapas.map((etapa, i) => {
          const passo = passos.get(etapa.id) ?? null;
          const erroDaLinha = erro?.etapaId === etapa.id ? erro.texto : null;
          const confirmandoAqui = confirmacao?.etapaId === etapa.id ? confirmacao : null;
          const arquivandoAqui = arquivamento?.etapaId === etapa.id ? arquivamento : null;
          const destinos = destinosPossiveis(etapas, etapa.id);

          return (
            <li
              key={`${etapa.id}:${etapa.name}`}
              className="flex flex-col gap-3 p-4"
              data-testid={`etapa-${etapa.id}`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <span className="w-6 shrink-0 text-xs tabular-nums text-text-muted">
                  {i + 1}.
                </span>

                <NomeDaEtapa
                  etapa={etapa}
                  desabilitado={ocupado}
                  aoConfirmar={(nome) => aplicar(etapa.id, { name: nome })}
                />

                <div className="flex w-[76px] shrink-0 items-center justify-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Mover «${etapa.name}» uma coluna para trás`}
                    data-testid={`subir-${etapa.id}`}
                    disabled={i === 0 || ocupado}
                    onClick={() =>
                      aplicar(etapa.id, { depois_de: vizinhoAoMover(etapas, i, "subir") })
                    }
                  >
                    <CaretUp size={16} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Mover «${etapa.name}» uma coluna para frente`}
                    data-testid={`descer-${etapa.id}`}
                    disabled={i === etapas.length - 1 || ocupado}
                    onClick={() =>
                      aplicar(etapa.id, { depois_de: vizinhoAoMover(etapas, i, "descer") })
                    }
                  >
                    <CaretDown size={16} aria-hidden />
                  </Button>
                </div>

                <div className="w-full shrink-0 sm:w-56">
                  <Select
                    value={papelDaEtapa(etapa)}
                    onValueChange={(v) => escolherPapel(etapa, v as Papel)}
                    disabled={ocupado}
                  >
                    <SelectTrigger
                      aria-label={`Papel de «${etapa.name}» no funil`}
                      data-testid={`papel-${etapa.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["nenhum", "won", "lost"] as const).map((p) => (
                        <SelectItem key={p} value={p}>
                          {ROTULO_DO_PAPEL[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="w-[104px] shrink-0"
                  data-testid={`arquivar-${etapa.id}`}
                  disabled={ocupado}
                  onClick={() => {
                    setErro(null);
                    setArquivamento({ etapaId: etapa.id, negocios: null, destino: null, erro: null });
                  }}
                >
                  <Archive size={16} className="mr-1" aria-hidden />
                  Arquivar
                </Button>
              </div>

              {passo && (
                <p className="text-xs text-text-muted" data-testid={`passo-de-${etapa.id}`}>
                  O assistente usa esta etapa para «{ROTULO_DO_PASSO[passo]}».{" "}
                  <a className="underline underline-offset-2" href={`#${ancoraMapeamento}`}>
                    Mudar isso
                  </a>
                </p>
              )}

              {confirmandoAqui && (
                <Card
                  className="flex flex-col gap-3 border-warning bg-warning-bg p-4"
                  data-testid={`confirmar-papel-${etapa.id}`}
                >
                  <p className="text-sm leading-relaxed">{confirmandoAqui.texto}</p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      data-testid={`confirmar-papel-sim-${etapa.id}`}
                      onClick={() => aplicar(etapa.id, patchDePapel(etapa, confirmandoAqui.papel))}
                    >
                      Marcar mesmo assim
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmacao(null)}>
                      Cancelar
                    </Button>
                  </div>
                </Card>
              )}

              {arquivandoAqui && (
                <Card
                  className="flex flex-col gap-3 border-border p-4"
                  data-testid={`arquivar-painel-${etapa.id}`}
                >
                  {arquivandoAqui.erro ? (
                    <p className="text-sm leading-relaxed" data-testid={`arquivar-erro-${etapa.id}`}>
                      {arquivandoAqui.erro}
                    </p>
                  ) : arquivandoAqui.negocios === null ? (
                    <p className="text-sm leading-relaxed">
                      Arquivar «{etapa.name}»? A coluna sai do quadro e para de receber negócios
                      novos. Nada é apagado — o histórico de quem passou por ela continua
                      guardado —, mas <strong>não dá para trazer a coluna de volta por aqui</strong>.
                    </p>
                  ) : destinos.length === 0 ? (
                    // Sem destino possível não há pergunta a fazer — e mandar
                    // escolher entre nada seria um beco sem saída.
                    <p className="text-sm leading-relaxed" data-testid={`arquivar-sem-destino-${etapa.id}`}>
                      {arquivandoAqui.negocios} negócios estão nesta etapa e não há outra coluna
                      em aberto para recebê-los. Crie uma etapa antes de arquivar «{etapa.name}».
                    </p>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed" data-testid={`arquivar-pergunta-${etapa.id}`}>
                        {arquivandoAqui.negocios} negócios estão nesta etapa. Para onde eles vão?
                      </p>
                      <div className="sm:w-72">
                        <Select
                          value={arquivandoAqui.destino ?? ""}
                          onValueChange={(v) =>
                            setArquivamento({ ...arquivandoAqui, destino: v })
                          }
                        >
                          <SelectTrigger
                            aria-label={`Para onde vão os negócios de «${etapa.name}»`}
                            data-testid={`destino-${etapa.id}`}
                          >
                            <SelectValue placeholder="Escolha a etapa" />
                          </SelectTrigger>
                          <SelectContent>
                            {destinos.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  <div className="flex gap-2">
                    {!arquivandoAqui.erro && !(arquivandoAqui.negocios !== null && destinos.length === 0) && (
                      <Button
                        size="sm"
                        data-testid={`arquivar-confirmar-${etapa.id}`}
                        // Com negócios na etapa, arquivar sem destino não é
                        // oferecido: perder o rastro deles não pode ser um
                        // clique de distância.
                        disabled={
                          ocupado ||
                          (arquivandoAqui.negocios !== null && !arquivandoAqui.destino)
                        }
                        onClick={() => pedirArquivamento(etapa, arquivandoAqui.destino)}
                      >
                        {arquivandoAqui.negocios === null
                          ? "Arquivar"
                          : "Mover os negócios e arquivar"}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setArquivamento(null)}>
                      {arquivandoAqui.erro ? "Fechar" : "Cancelar"}
                    </Button>
                  </div>
                </Card>
              )}

              {erroDaLinha && (
                <Card
                  className="flex items-start gap-3 border-warning bg-warning-bg p-4"
                  data-testid={`etapa-erro-${etapa.id}`}
                >
                  <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
                  <p className="text-sm leading-relaxed">
                    {erroDaLinha}
                    {passo && (
                      <>
                        {" "}
                        <a className="underline underline-offset-2" href={`#${ancoraMapeamento}`}>
                          Ir para o mapeamento do assistente
                        </a>
                        .
                      </>
                    )}
                  </p>
                </Card>
              )}
            </li>
          );
        })}
      </ul>

      {nova === null ? (
        <Button variant="ghost" size="sm" data-testid="nova-etapa" onClick={() => setNova("")}>
          <Plus size={16} className="mr-1" aria-hidden />
          Acrescentar etapa ao fim
        </Button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            autoFocus
            value={nova}
            maxLength={80}
            placeholder="Nome da nova coluna"
            aria-label="Nome da nova etapa"
            data-testid="nova-etapa-nome"
            onChange={(e) => setNova(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") criarEtapa();
              if (e.key === "Escape") setNova(null);
            }}
            className="sm:w-72"
          />
          <Button
            size="sm"
            data-testid="nova-etapa-criar"
            disabled={ocupado || nova.trim().length === 0}
            onClick={criarEtapa}
          >
            Criar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNova(null)}>
            Cancelar
          </Button>
        </div>
      )}

      {erro?.etapaId === null && (
        <Card
          className="flex items-start gap-3 border-warning bg-warning-bg p-4"
          data-testid="etapas-erro"
        >
          <Warning size={18} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
          <p className="text-sm leading-relaxed">{erro.texto}</p>
        </Card>
      )}
    </div>
  );
}

/**
 * O nome da etapa, editado no lugar.
 *
 * ⚠️ SALVA AO CONFIRMAR (Enter ou sair do campo), NUNCA A CADA TECLA: um PATCH
 * por caractere gravaria "P", "Pr", "Pro"… no banco e faria a validação de nome
 * duplicado disparar no meio da digitação. O rascunho é local; a fonte da verdade
 * continua sendo o servidor — a linha inteira é remontada quando o nome gravado
 * muda (`key` da `li`), então uma edição feita em outra aba não fica escondida
 * atrás de um rascunho velho.
 */
function NomeDaEtapa({
  etapa,
  desabilitado,
  aoConfirmar,
}: {
  etapa: EtapaDoFunil;
  desabilitado: boolean;
  aoConfirmar: (nome: string) => void;
}) {
  const [rascunho, setRascunho] = useState(etapa.name);

  function confirmar() {
    const nome = rascunho.trim();
    if (!nome || nome === etapa.name) {
      setRascunho(etapa.name);
      return;
    }
    aoConfirmar(nome);
  }

  return (
    <Input
      value={rascunho}
      maxLength={80}
      disabled={desabilitado}
      aria-label={`Nome da etapa «${etapa.name}»`}
      data-testid={`nome-${etapa.id}`}
      onChange={(e) => setRascunho(e.target.value)}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setRascunho(etapa.name);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1"
    />
  );
}
