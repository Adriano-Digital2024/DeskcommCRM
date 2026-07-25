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

/**
 * Quanto tempo uma mudança minha continua sendo "minha".
 *
 * É JANELA, e não uma marca gasta por evento, porque UMA ação do usuário
 * produz VÁRIAS escritas na mesma linha. Medido no arrasto de card: a rota
 * grava `stage_id`/`position_in_stage`, e ~112 ms depois a atividade
 * `stage_changed` do barramento (Wave 3) carimba `last_activity_at` — dois
 * `UPDATE`, dois eventos de realtime, uma única ação do usuário.
 *
 * 2 s é ~18× a distância medida entre as duas escritas (folga para uma cadeia
 * mais longa) e curto o bastante para não engolir a mudança de outra pessoa no
 * MESMO lead logo em seguida.
 */
const JANELA_MS = 2_000;

/** Chamado pelas mutações locais, ANTES de o evento voltar pelo realtime. */
export function marcarEcoLocal(leadId: string, agora = Date.now()): void {
  ECOS.set(leadId, agora);
}

/**
 * Este evento é eco da minha própria ação?
 *
 * NÃO consome a marca ao responder que sim — ela expira por tempo. Consumir era
 * o defeito (`12.c`): a primeira escrita da ação gastava a marca, e a segunda
 * chegava sem lastro e pulsava. A aba que agiu piscava sozinha, que é
 * exatamente o ruído que esta peça existe para evitar.
 */
export function ehEcoLocal(leadId: string, agora = Date.now()): boolean {
  const marcado = ECOS.get(leadId);
  if (marcado === undefined) return false;
  if (agora - marcado <= JANELA_MS) return true;
  ECOS.delete(leadId); // marca vencida é lixo; o próximo evento pulsa.
  return false;
}

/** Só para testes: zera o estado de módulo. */
export function limparEcosLocais(): void {
  ECOS.clear();
}
