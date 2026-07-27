import { LEAD_STAGES, type LeadStage } from "@/lib/agent-engine/agent/lead-state";

/**
 * As regras do mapeamento passo-do-agente → etapa-do-tenant, sem tocar no banco.
 *
 * A ponte é `crm_stages.agent_stage_hint` (migration 0084) e ela JÁ MOVE cards em
 * produção — só que nenhuma tela do produto escreve nessa coluna ainda. Este
 * arquivo é a camada pura que sustenta essa tela.
 *
 * ⚠️ POR QUE VALIDAR SE O BANCO JÁ RECUSA. O CHECK é a rede de segurança, não a
 * primeira linha: um `23514` cru chega ao dono da clínica como "violates check
 * constraint crm_stages_hint_coerente_com_won_lost", que não ensina nada e não
 * diz QUAL etapa está errada. As mensagens daqui vão direto para a tela — por
 * isso citam o NOME da etapa e o rótulo em português do passo, nunca o id nem o
 * token interno ('won', 'e2').
 *
 * ⚠️ `null` É RESPOSTA, NÃO PENDÊNCIA. "Em separação" e "Pós-venda" não têm
 * equivalente no funil do agente; a 0084 diz isso explicitamente. Tratar passo
 * sem etapa como erro cobraria do tenant uma escolha que ele já fez.
 */

/** O que a tela sabe de cada etapa. Arquivadas não chegam aqui — quem monta a lista filtra. */
export interface EtapaDoMapa {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
  agent_stage_hint: string | null;
}

/**
 * Passo → id da etapa escolhida (`null` = de propósito sem etapa).
 *
 * Chave é `string`, não `LeadStage`, de propósito: isto vem de request body, e o
 * vocabulário fechado do CHECK precisa ser verificado em runtime — tipo não
 * valida JSON que chegou pela rede.
 */
export type EntradaDeMapeamento = Record<string, string | null | undefined>;

export type ResultadoValidacao = { ok: true } | { ok: false; erros: string[] };

/**
 * Como cada passo do agente se chama para quem não conhece o produto por dentro.
 *
 * Exportado porque a TELA precisa exatamente destes rótulos: dois lugares
 * traduzindo 'negotiating' à mão viram duas traduções diferentes no primeiro
 * ajuste — a família de defeito que a própria 0084 nasceu para fechar.
 */
export const ROTULO_DO_PASSO: Readonly<Record<LeadStage, string>> = {
  new: "Novo lead",
  contacted: "Primeiro contato",
  qualifying: "Em qualificação",
  qualified: "Qualificado",
  negotiating: "Em negociação",
  won: "Ganho",
  lost: "Perdido",
};

function ehPasso(valor: string): valor is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(valor);
}

/** Recusa o que o banco recusaria — antes de tocar o banco, e em português. */
export function validarMapeamento(
  entrada: EntradaDeMapeamento,
  etapas: EtapaDoMapa[],
): ResultadoValidacao {
  const erros: string[] = [];
  const etapaJaUsadaPor = new Map<string, LeadStage>();

  for (const [passo, stageId] of Object.entries(entrada)) {
    // Chave ausente e chave com `undefined` são a mesma coisa: passo não mexido.
    if (stageId === undefined) continue;

    if (!ehPasso(passo)) {
      erros.push(`«${passo}» não é um passo do atendimento do assistente.`);
      continue;
    }
    const rotulo = ROTULO_DO_PASSO[passo];

    // `null` é escolha do tenant, não omissão — nada a validar.
    if (stageId === null) continue;

    const etapa = etapas.find((e) => e.id === stageId);
    if (!etapa) {
      erros.push(
        `A etapa escolhida para «${rotulo}» não faz parte deste funil. Recarregue a página e escolha de novo.`,
      );
      continue;
    }

    // O índice único `uniq_crm_stages_pipeline_hint`: uma etapa, um passo.
    const donoAnterior = etapaJaUsadaPor.get(etapa.id);
    if (donoAnterior) {
      erros.push(
        `A etapa «${etapa.name}» já representa «${ROTULO_DO_PASSO[donoAnterior]}» e não pode representar «${rotulo}` +
          `» também. Cada etapa vale por um passo só.`,
      );
      continue;
    }
    etapaJaUsadaPor.set(etapa.id, passo);

    // Coerência com is_won/is_lost, nos DOIS sentidos (CHECK da 0084). Sem os
    // dois, `is_won` e o hint viram duas fontes capazes de discordar sobre o
    // mesmo lugar do funil.
    if (passo === "won" && !etapa.is_won) {
      erros.push(
        `A etapa «${etapa.name}» não é a etapa de fechamento (ganho) deste funil, então não pode representar «${rotulo}».`,
      );
    } else if (passo === "lost" && !etapa.is_lost) {
      erros.push(
        `A etapa «${etapa.name}» não é a etapa de perda deste funil, então não pode representar «${rotulo}».`,
      );
    } else if (etapa.is_won && passo !== "won") {
      erros.push(
        `A etapa «${etapa.name}» é a etapa de ganho deste funil, então só pode representar «${ROTULO_DO_PASSO.won}».`,
      );
    } else if (etapa.is_lost && passo !== "lost") {
      erros.push(
        `A etapa «${etapa.name}» é a etapa de perda deste funil, então só pode representar «${ROTULO_DO_PASSO.lost}».`,
      );
    }
  }

  return erros.length === 0 ? { ok: true } : { ok: false, erros };
}

export interface UpdateDeEtapa {
  stageId: string;
  hint: LeadStage | null;
}

/**
 * O mapa desejado traduzido nos UPDATEs mínimos.
 *
 * Chame DEPOIS de `validarMapeamento` — aqui não há veredito, só diferença.
 *
 * ⚠️ SÓ OS PASSOS MENCIONADOS NA ENTRADA ENTRAM NA CONTA. Mapa parcial (a tela
 * mandando um passo só) não pode apagar o que o tenant configurou em outra
 * sessão — "ausente" significa "não mexi nisso", nunca "limpe". Para limpar, a
 * entrada diz `null` explicitamente.
 *
 * ⚠️ OS UNSETs VÊM PRIMEIRO, e não é estética: `uniq_crm_stages_pipeline_hint`
 * recusaria o passo migrando para a etapa nova enquanto a antiga ainda o declara.
 */
export function diffParaUpdates(
  atual: EtapaDoMapa[],
  desejado: EntradaDeMapeamento,
): UpdateDeEtapa[] {
  const passosEmJogo = new Set(
    Object.entries(desejado)
      .filter(([, v]) => v !== undefined)
      .map(([passo]) => passo),
  );

  const limpar: UpdateDeEtapa[] = [];
  const ocupar: UpdateDeEtapa[] = [];

  for (const etapa of atual) {
    const alvoDaEtapa = Object.entries(desejado).find(
      ([, stageId]) => stageId === etapa.id,
    )?.[0];

    if (alvoDaEtapa) {
      if (etapa.agent_stage_hint !== alvoDaEtapa && ehPasso(alvoDaEtapa)) {
        ocupar.push({ stageId: etapa.id, hint: alvoDaEtapa });
      }
      continue;
    }

    // A etapa perdeu o passo que declarava — mas só se esse passo estava em jogo.
    if (etapa.agent_stage_hint && passosEmJogo.has(etapa.agent_stage_hint)) {
      limpar.push({ stageId: etapa.id, hint: null });
    }
  }

  return [...limpar, ...ocupar];
}
