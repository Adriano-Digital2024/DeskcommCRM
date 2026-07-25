/**
 * O que EU acabei de mudar — para o card não pulsar na minha própria ação.
 *
 * O Postgres avisa todo mundo, inclusive quem fez a mudança. Sem isto, arrastar
 * um card faria ele piscar na sua cara: a ação local já tem o feedback dela (o
 * card se move sob o cursor), e pulsar de novo é ruído com cara de novidade.
 * O pulso existe para o que chegou de FORA.
 *
 * A marca segue o CICLO DE VIDA DA MUTAÇÃO, não um relógio: abre quando a ação
 * começa, fecha quando ela assenta (`onSettled`) mais uma folga curta para o
 * evento atrasado. Assim a janela é o tempo que a ação REALMENTE levou —
 * medido, não estimado —, e se ajusta sozinha ao fluxo e à máquina.
 *
 * Por que isso importa aqui: uma ação do usuário produz VÁRIAS escritas na
 * linha. No arrasto, a rota grava `stage_id`/`position_in_stage` e depois, com
 * três consultas no meio, a atividade `stage_changed` carimba
 * `last_activity_at` — dois `UPDATE`, dois eventos de realtime. Ganhar e perder
 * mexem também em `status`; o bulk mexe em vários leads. **A cascata tem
 * tamanho diferente por fluxo**, então qualquer constante calibrada no arrasto
 * estaria errada nos outros — e numa VPS modesta, errada em todos.
 *
 * Memória de processo, sem persistência: se a aba recarregar, o eco se perde e
 * o pior caso é um pulso a mais — nunca um evento remoto silenciado.
 */
interface Marca {
  /**
   * Quantas mutações minhas estão em voo sobre este lead.
   *
   * CONTADOR, e não booleano, porque as ações se sobrepõem: arrastar o mesmo
   * card duas vezes seguidas é gesto comum, e o bulk mexe em vários leads com
   * tempos diferentes. Com um valor só, o `onSettled` da primeira liberaria a
   * marca com a segunda ainda rodando.
   */
  emVoo: number;
  /** Quando a mutação mais recente começou (base do fallback). */
  aberta: number;
  /** Quando a ÚLTIMA em voo assentou, ou null se ainda há alguma. */
  assentada: number | null;
}

const ECOS = new Map<string, Marca>();

/**
 * Folga depois que a mutação assenta, para o último evento da cascata chegar.
 *
 * Cobre só o trecho que sobra depois da resposta: commit, distribuição e
 * websocket. O caro — as idas ao banco dentro do handler — já está coberto pelo
 * tempo real da mutação.
 */
const FOLGA_MS = 1_000;

/**
 * Rede de segurança para a mutação que NUNCA assenta (aba suspensa, rede caída,
 * `onSettled` que não roda). Sem isto a marca ficaria para sempre e o lead
 * pararia de pulsar de vez, que é o erro caro.
 *
 * 4 s, e não um número justo: errar para cá custa **um pulso perdido** — falha
 * cosmética, e o dado atualiza igual. Errar para menos ressuscita o defeito do
 * `12.c`, intermitente e só sob carga. Entre o barato e o caro, o desenho
 * escolhe o barato.
 */
const FALLBACK_MS = 4_000;

/** A ação começou (chamado antes de o evento voltar pelo realtime). */
export function marcarEcoLocal(leadId: string, agora = Date.now()): void {
  const marca = ECOS.get(leadId);
  if (marca) {
    // Segunda ação sobre o MESMO card antes de a primeira assentar —
    // reposicionar duas vezes seguidas é gesto comum. Conta, não sobrescreve.
    marca.emVoo += 1;
    marca.aberta = agora;
    marca.assentada = null;
    return;
  }
  ECOS.set(leadId, { emVoo: 1, aberta: agora, assentada: null });
}

/**
 * A ação assentou (`onSettled`): a marca ainda vale por `FOLGA_MS`.
 *
 * Não apaga na hora — o último evento da cascata costuma chegar DEPOIS da
 * resposta HTTP, e apagar aqui traria o defeito de volta pela porta dos fundos.
 *
 * Só começa a contar a folga quando a ÚLTIMA ação em voo assenta. Sem o
 * contador, o `onSettled` da primeira liberaria a marca com a segunda ainda
 * rodando, e os eventos dela pulsariam na própria aba — o mesmo defeito, agora
 * intermitente e dependente de timing, que é a versão cara dele.
 */
export function liberarEcoLocal(leadId: string, agora = Date.now()): void {
  const marca = ECOS.get(leadId);
  if (!marca) return;
  marca.emVoo -= 1;
  if (marca.emVoo > 0) return;
  marca.emVoo = 0;
  marca.assentada = agora;
}

/**
 * Este evento é eco da minha própria ação?
 *
 * NÃO consome a marca ao responder que sim — era esse o defeito do `12.c`: a
 * primeira escrita da ação gastava a marca e a segunda pulsava, fazendo a aba
 * que agiu piscar sozinha.
 */
export function ehEcoLocal(leadId: string, agora = Date.now()): boolean {
  const marca = ECOS.get(leadId);
  if (!marca) return false;

  const vencida =
    marca.assentada === null
      ? agora - marca.aberta > FALLBACK_MS
      : agora - marca.assentada > FOLGA_MS;

  if (vencida) {
    ECOS.delete(leadId); // marca velha é lixo; o próximo evento pulsa.
    return false;
  }
  return true;
}

/** Só para testes: zera o estado de módulo. */
export function limparEcosLocais(): void {
  ECOS.clear();
}
