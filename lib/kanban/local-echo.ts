/**
 * O que EU acabei de mudar — para o card não pulsar na minha própria ação.
 *
 * O Postgres avisa todo mundo, inclusive quem fez a mudança. Sem isto, arrastar
 * um card faria ele piscar na sua cara: a ação local já tem o feedback dela (o
 * card se move sob o cursor), e pulsar de novo é ruído com cara de novidade.
 * O pulso existe para o que chegou de FORA.
 *
 * Memória de processo, sem persistência: se a aba recarregar, o eco se perde e
 * o pior caso é um pulso a mais — nunca um evento remoto silenciado.
 */
const ECOS = new Map<string, number>();

/** Quanto tempo uma mudança minha continua sendo "minha". */
const JANELA_MS = 4_000;

/** Chamado pelas mutações locais, ANTES de o evento voltar pelo realtime. */
export function marcarEcoLocal(leadId: string, agora = Date.now()): void {
  ECOS.set(leadId, agora);
}

/**
 * Este evento é eco da minha própria ação? Consome a marca ao responder que
 * sim: o segundo evento sobre o mesmo lead já é mudança de outra pessoa.
 */
export function consumirEcoLocal(leadId: string, agora = Date.now()): boolean {
  const marcado = ECOS.get(leadId);
  if (marcado === undefined) return false;
  ECOS.delete(leadId);
  return agora - marcado <= JANELA_MS;
}

/** Só para testes: zera o estado de módulo. */
export function limparEcosLocais(): void {
  ECOS.clear();
}
