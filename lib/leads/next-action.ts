import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

/** Uma linha de `lead_state` que interessa ao board. */
export interface EstadoDoContato {
  contact_id: string;
  next_action: string | null;
  updated_at: string;
}

/** O que o card precisa saber sobre a próxima ação proposta. */
export interface ProximaAcao {
  label: string;
  /**
   * O texto que o humano está vendo, repetido de propósito.
   *
   * A trava de autorização compara TEXTO, não timestamp: é o texto que a pessoa
   * leu e aprovou. Mandá-lo junto deixa o contrato explícito em vez de esperar
   * que o cliente lembre de reenviar o que renderizou.
   */
  approved_text: string;
  proposed_at: string;
}

/**
 * De qual LEAD é a próxima ação que o agente escreveu para um CONTATO.
 *
 * `lead_state` é por contato; o card é um negócio. Uma pessoa pode ter N
 * negócios abertos, então juntar por `contact_id` faria a MESMA proposta
 * aparecer em N cards — e aprovar num executaria pelos outros. Uma ação, N
 * botões: é o vazamento da Wave 1 em outra roupa.
 *
 * Por isso a proposta vai para o lead ATIVO do contato, e **quando há
 * ambiguidade não vai para nenhum** — a mesma polaridade de
 * `resolveActiveLeadForContact`, que é reusado aqui em vez de reescrito. Um
 * segundo roteador seria uma segunda regra para divergir da primeira.
 *
 * `candidatos` precisa conter TODOS os negócios abertos do contato na org, não
 * só os do pipeline aberto na tela: com a lista recortada por pipeline, dois
 * negócios ambíguos em boards diferentes pareceriam um único negócio em cada
 * um, e cada board mostraria a proposta como se fosse dele.
 */
export function roteiaProximasAcoes(
  estados: EstadoDoContato[],
  candidatos: Array<LeadCandidate & { contact_id: string | null }>,
  opts: { defaultPipelineId?: string | null } = {},
): Map<string, ProximaAcao> {
  const porContato = new Map<string, Array<LeadCandidate & { contact_id: string | null }>>();
  for (const c of candidatos) {
    if (!c.contact_id) continue;
    const lista = porContato.get(c.contact_id);
    if (lista) lista.push(c);
    else porContato.set(c.contact_id, [c]);
  }

  const porLead = new Map<string, ProximaAcao>();
  for (const estado of estados) {
    const texto = estado.next_action?.trim();
    if (!texto) continue; // sem proposta não há slot — o card fica NORMAL.

    const doContato = porContato.get(estado.contact_id);
    if (!doContato || doContato.length === 0) continue;

    const rota = resolveActiveLeadForContact(doContato, opts);
    if (!rota.routed) continue; // ambíguo ou sem negócio aberto: não aparece em nenhum.

    porLead.set(rota.leadId, {
      label: texto,
      approved_text: texto,
      proposed_at: estado.updated_at,
    });
  }
  return porLead;
}
