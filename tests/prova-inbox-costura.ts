/**
 * O INBOX SE CONTRADIZ NA MESMA TELA — por quanto tempo?
 *
 * Na captura do raio do silêncio, a conversa aberta já mostrava a mensagem nova
 * enquanto a lista à esquerda, na MESMA foto, continuava dizendo "Sem mensagens"
 * para aquela mesma conversa. Dois painéis da mesma tela discordando sobre o
 * mesmo fato.
 *
 * Isso não depende de realtime estar morto: é defeito de COSTURA, e a costura é
 * o único lugar sem dono — cada painel está certo sozinho. O que ninguém mediu é
 * QUANTO TEMPO a tela fica mentindo, e essa duração é o defeito: se for 200ms,
 * ninguém vê; se for indefinida, o operador atende pela lista e a lista está
 * errada.
 *
 * E o inbox foi a superfície mais instável do dia — quatro rodadas idênticas,
 * três resultados diferentes. Por isso aqui é TAXA, nunca uma foto.
 *
 * O QUE SE MEDE, por painel e por rodada:
 *   quando a CONVERSA aberta passa a mostrar a mensagem;
 *   quando a LISTA passa a refletir que aquela conversa tem mensagem nova;
 *   a JANELA DE DISCORDÂNCIA = |um − outro|, que é o tempo em que a tela mente.
 *
 * Sem proxy e sem sabotagem: a entrega está viva hoje, e o objetivo é o
 * comportamento NORMAL do produto — não o degradado, que já está medido.
 *
 * Run: E2E_PORT=3020 RODADAS=4 npx tsx tests/prova-inbox-costura.ts
 */
import { chromium, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { BASE, CREDS, carimbar, criarPlacar, login } from "./qa-helpers";

/**
 * LINHA DE BASE DECLARADA, medida em 25/07 no commit e65eb5f, ANTES da wave 8.
 *
 * Sem ela este critério reprovaria a wave 8 por um defeito que ela não causou —
 * o suspeito mais recente levando a culpa. Com ela, o critério distingue três
 * coisas que um passa/falha funde: REGRESSÃO (piorou), DEFEITO PREEXISTENTE
 * (igual) e CONSERTO (melhorou, e aí alguém tem de subir a linha de base).
 *
 * A raiz já está nomeada pelo regente: `last_message_preview` e
 * `last_message_at` são colunas desnormalizadas em `conversations` mantidas por
 * CAMINHO DE APLICAÇÃO, sem trigger em `messages`. A mediana de defasagem é
 * 0,0h — o fluxo comum funciona; o defeito está na CAUDA (uma conversa com
 * preview nulo tendo mensagens, outra defasada em 69 dias). Então a pergunta
 * não é "está quebrado?", é "qual caminho de escrita não atualiza?".
 */
const LINHA_DE_BASE = {
  quando: "25/07, medida pelo caminho de produção",
  desfecho: "acompanha ao vivo" as Desfecho,
};

/**
 * ⚠️ A BASE ANTERIOR ERA "nem recarregando" E ESTAVA ERRADA — e a distinção
 * importa para quem ler daqui a seis meses: ela NÃO subiu porque um conserto
 * entrou. Ela subiu porque a medição que a produziu era inválida.
 *
 * Aquela versão inseria em `messages` direto pelo cliente de serviço e nunca
 * chamava `fn_mark_conversation_message` — a RPC que `lib/waha/ingest.ts` executa
 * DEPOIS do insert e que mantém `last_message_preview`/`last_message_at`. A lista
 * lê essa coluna. Eu pulei o escritor e cobrei o resultado dele.
 *
 * Medido pelo caminho certo: 0ms de discordância, 2 de 2. A tela sempre esteve
 * certa — ela mostra o que a coluna diz, e a coluna não tinha por que mudar.
 *
 * Se alguém marcar isto como "conserto de 25/07" vai procurar um commit que não
 * existe.
 */

/** Os três desfechos, em ordem de gravidade crescente. O contrato do 27 pedia
 *  "sem regressão", e passa/falha não distingue regressão de defeito herdado. */
type Desfecho = "acompanha ao vivo" | "só recarregando" | "nem recarregando" | "indecidível";
const GRAVIDADE: Desfecho[] = ["acompanha ao vivo", "só recarregando", "nem recarregando", "indecidível"];

const env: Record<string, string> = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const ORG = CREDS.org_id as string;
const RUN = randomUUID().slice(0, 6);

interface Rodada {
  conversa: number | null;
  lista: number | null;
  entregue: boolean;
  /** `true` se a lista só passou a refletir DEPOIS de um recarregamento. */
  recarregouCorrigiu: boolean | null;
}

async function rodada(page: Page, conversaId: string, contactId: string, sessionId: string, i: number): Promise<Rodada> {
  await page.goto(`${BASE}/app/inbox?id=${conversaId}`);
  await page.waitForTimeout(3500);

  // OS DOIS PAINÉIS SÃO LIDOS PELO MESMO CRITÉRIO: o texto da marca. Ler a
  // conversa por texto e a lista por "tem badge" mediria coisas diferentes e a
  // discordância viria da minha régua, não da tela.
  const corpo = async (): Promise<string> =>
    ((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");

  const marca = `COSTURA${RUN}${i}`;
  const antes = await corpo();
  if (antes.includes(marca)) throw new Error("a marca já estava na tela antes da ação");

  const t0 = Date.now();
  // A ESCRITA PASSA PELO MESMO MARCADOR QUE O CAMINHO DE PRODUÇÃO USA.
  //
  // A primeira versão inseria direto em `messages` — e a lista NUNCA atualizava.
  // Eu ia entregar isso como defeito de produto. Não é: `lib/waha/ingest.ts`
  // chama a RPC `fn_mark_conversation_message` DEPOIS do insert, e é ela que
  // mantém `last_message_preview`/`last_message_at`. Inserindo à mão eu pulei o
  // escritor e medi uma coluna que ninguém tinha mandado atualizar.
  //
  // É a lei que eu venho cobrando dos outros mordendo em mim: INSERT à mão prova
  // a tela e MENTE SOBRE A ORIGEM. A tela estava certa — ela mostra o que a
  // coluna diz, e a coluna não tinha por que mudar.
  const { error } = await admin.from("messages").insert({
    organization_id: ORG,
    conversation_id: conversaId,
    contact_id: contactId,
    channel_session_id: sessionId,
    direction: "inbound",
    type: "text",
    // A MARCA VAI NO COMEÇO. A linha da lista mostra uma PRÉVIA truncada — se o
    // marcador ficar no fim, a apresentação o corta e eu leria "a lista não
    // acompanhou" sobre uma lista que acompanhou e só não coube. Exigir o que o
    // truncamento remove é o falso vermelho por forma, de novo.
    body: `${marca} mensagem de costura`,
    status: "delivered",
    sent_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`gatilho: ${error.message}`);
  const { error: erroMarca } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversaId,
    p_direction: "inbound",
    p_preview: `${marca} mensagem de costura`,
    p_at: new Date().toISOString(),
  } as never);
  if (erroMarca) throw new Error(`marcador da conversa: ${erroMarca.message}`);

  // A LISTA é lida DENTRO da coluna da esquerda, não na página inteira: a
  // conversa aberta também contém a marca, e procurar no corpo todo faria a
  // lista "acertar" por causa do painel vizinho. Teste confundido clássico.
  // A LINHA DA CONVERSA ABERTA, não a coluna inteira. `ConversationListItem`
  // marca a selecionada com `aria-current="true"` — é o único atributo estável
  // que a lista expõe, e isola exatamente o painel que se contradizia com a
  // thread na captura de hoje. Ler a coluna inteira misturaria as outras
  // conversas e o filtro; ler o corpo da página faria a lista "acertar" por
  // causa da thread ao lado.
  const listaLoc = page.locator('button[aria-current="true"]').first();
  // TIMEOUT CURTO E EXPLÍCITO. O `.catch(() => "")` NÃO evita a espera — ele só
  // engole o erro DEPOIS do timeout padrão de 60s. Com 15 amostras por rodada,
  // o meu próprio aparato levaria 15 minutos por rodada e eu ia culpar o
  // ambiente. Instrumento lento é instrumento quebrado com outra roupa.
  const lista = async (): Promise<string> =>
    ((await listaLoc.innerText({ timeout: 1500 }).catch(() => "")) ?? "").replace(/\s+/g, " ");

  // PRÉ-CONDIÇÃO: o painel da lista PRECISA existir. Sem esta checagem, um
  // localizador que nunca resolve produziria "a lista nunca acompanhou em 4/4" —
  // vermelho sobre o produto causado pelo meu seletor. É a família que eu venho
  // caçando o dia inteiro, agora na minha própria mão.
  if ((await listaLoc.count()) === 0) {
    throw new Error(
      "[pré-condição] não encontrei o painel da LISTA de conversas — sem ele não há costura a medir, " +
        "e reportar 'a lista não acompanhou' seria acusar o produto pelo meu seletor",
    );
  }

  let naConversa: number | null = null;
  let naLista: number | null = null;
  for (let t = 0; t < 15 && (naConversa === null || naLista === null); t++) {
    await page.waitForTimeout(2000);
    const ms = Date.now() - t0;
    if (naConversa === null && (await corpo()).includes(marca)) naConversa = ms;
    if (naLista === null && (await lista()).includes(marca)) naLista = ms;
  }

  // E O QUE A LINHA DIZ, para o laudo não ser só "não apareceu": sem o texto
  // observado, "a lista não acompanhou" não distingue lista velha de lista que
  // mostra outra coisa.
  // E O RECARREGAMENTO SEPARA DOIS DEFEITOS MUITO DIFERENTES: "não atualiza ao
  // vivo" (o operador aperta F5 e resolve) e "não atualiza nem recarregando" (a
  // lista está errada e continua errada). Sem esta leitura eu reportaria o
  // primeiro e o segundo seria descoberto por um atendente.
  let apoRecarga = "(não medido)";
  if (naLista === null) {
    await page.reload();
    await page.waitForTimeout(4000);
    apoRecarga = (await lista()).includes(marca) ? "SIM, depois de recarregar" : "NEM recarregando";
  }
  const textoDaLinha = (await lista()).slice(0, 110);
  await admin.from("messages").delete().like("body", `${marca}%`);
  if (naLista === null)
    console.info(`      (a linha dizia: "${textoDaLinha}") · corrige ao recarregar: ${apoRecarga}`);
  return {
    conversa: naConversa,
    lista: naLista,
    entregue: naConversa !== null,
    recarregouCorrigiu: apoRecarga === "(não medido)" ? null : apoRecarga.startsWith("SIM"),
  };
}

async function main(): Promise<void> {
  carimbar([
    "tests/prova-inbox-costura.ts",
    "hooks/inbox/useMessagesRealtime.ts",
    "hooks/inbox/useConversationsRealtime.ts",
  ]);
  const RODADAS = Number(process.env.RODADAS ?? "4");

  const { data: convs } = await admin
    .from("conversations")
    .select("id,contact_id,channel_session_id")
    .eq("organization_id", ORG)
    .order("id")
    .limit(1);
  const c = (convs ?? [])[0] as { id: string; contact_id: string; channel_session_id: string };

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(60_000);
  await login(page, "manager");

  const rs: Rodada[] = [];
  for (let i = 1; i <= RODADAS; i++) {
    const r = await rodada(page, c.id, c.contact_id, c.channel_session_id, i);
    const conv = r.conversa === null ? "NUNCA (30s)" : `${r.conversa}ms`;
    const lst = r.lista === null ? "NUNCA (30s)" : `${r.lista}ms`;
    const janela =
      r.conversa !== null && r.lista !== null
        ? `${Math.abs(r.lista - r.conversa)}ms de discordância`
        : r.conversa !== null
          ? "discordância NÃO FECHOU em 30s"
          : "(a conversa nem recebeu — nada a comparar)";
    console.info(`  rodada ${i} · conversa=${conv.padEnd(12)} lista=${lst.padEnd(12)} · ${janela}`);
    rs.push(r);
  }
  await browser.close();

  const recebeu = rs.filter((r) => r.conversa !== null).length;
  const listaOk = rs.filter((r) => r.lista !== null).length;

  // ---- o critério do cenário 27 --------------------------------------------
  const { record, fechar } = criarPlacar("CENÁRIO 27 · a lista acompanha a conversa", ["C27.costura"]);
  const recarregou = rs.some((r) => r.recarregouCorrigiu === true);
  const desfechoMedido: Desfecho =
    recebeu === 0
      ? "indecidível"
      : listaOk === recebeu
        ? "acompanha ao vivo"
        : recarregou
          ? "só recarregando"
          : "nem recarregando";
  // C27_SIMULA força o desfecho para exercitar os ramos. Os três só rodam
  // naturalmente em dias diferentes — "melhorou" só no dia do conserto, e é
  // justamente o dia em que ninguém repara que a cerca não avisou. E a
  // sabotagem tem de atingir a CONJUNÇÃO inteira: aqui o desfecho é a única
  // condição, mas eu já fui pego sabotando metade de um `&&`.
  const desfecho: Desfecho = (process.env.C27_SIMULA as Desfecho) ?? desfechoMedido;
  const piorou = GRAVIDADE.indexOf(desfecho) > GRAVIDADE.indexOf(LINHA_DE_BASE.desfecho);
  const melhorou = GRAVIDADE.indexOf(desfecho) < GRAVIDADE.indexOf(LINHA_DE_BASE.desfecho);
  record(
    "C27.costura",
    "a linha da conversa aberta reflete a mensagem que a thread já mostra",
    desfecho === "acompanha ao vivo",
    desfecho === "indecidível"
      ? "INDECIDÍVEL: nem a conversa recebeu a mensagem — sem isso não há costura a julgar"
      : melhorou
        ? `MELHOROU: desfecho "${desfecho}" contra a linha de base "${LINHA_DE_BASE.desfecho}" ` +
          `(${LINHA_DE_BASE.quando}). Se o conserto entrou, SUBA A LINHA DE BASE — senão este ` +
          `critério para de detectar a próxima regressão.`
        : piorou
          ? `REGRESSÃO: desfecho "${desfecho}" contra a linha de base "${LINHA_DE_BASE.desfecho}" ` +
            `(${LINHA_DE_BASE.quando}) — piorou nesta wave`
          : `DEFEITO PREEXISTENTE, não regressão desta wave: desfecho "${desfecho}", igual à linha ` +
            `de base de ${LINHA_DE_BASE.quando}. A lista segue dizendo "Sem mensagens" com a ` +
            `mensagem aberta ao lado. Raiz nomeada: colunas desnormalizadas em conversations ` +
            `mantidas por caminho de aplicação, sem trigger — a mediana de defasagem é 0,0h e o ` +
            `defeito está na cauda, então a pergunta é QUAL escritor não atualiza.`,
    // MELHOROU É VERMELHO, de propósito. Se o conserto entrou e a linha de base
    // não sobe, este critério passa a aprovar um estado que ele deveria vigiar —
    // e a próxima regressão volta ao patamar antigo sem disparar nada. É a
    // catraca: alguém tem de subir a base conscientemente. BLOQUEADO fica só
    // para o defeito herdado, que não é desta wave e não tem o que reprovar.
    // E MELHOROU É VERMELHO MESMO QUANDO O DESFECHO É O IDEAL. O autoteste me
    // pegou aqui: com "acompanha ao vivo" o critério dava PASS enquanto a
    // mensagem pedia para subir a linha de base — passa/falha e a instrução se
    // contradiziam, e PASS ganha, porque ninguém age sobre verde. A catraca
    // falhava exatamente no caso para o qual ela existe: o dia do conserto.
    desfecho === "indecidível"
      ? "INCONCLUSIVO"
      : melhorou
        ? "FALHA"
        : !piorou
          ? "BLOQUEADO"
          : undefined,
  );
  console.info(
    `\n=== ${RODADAS} rodadas ===\n` +
      `  a CONVERSA aberta mostrou a mensagem: ${recebeu}/${RODADAS}\n` +
      `  a LISTA acompanhou dentro de 30s ...: ${listaOk}/${RODADAS}\n`,
  );
  console.info(
    recebeu === 0
      ? "==> nem a conversa recebeu: sem isso não há costura a julgar, e a rodada não mede nada."
      : listaOk === recebeu
        ? "==> os dois painéis acompanham. A discordância da captura de hoje foi transitória, e a\n" +
          "    janela medida acima é o tempo em que a tela pode ser lida errada."
        : `==> A TELA SE CONTRADIZ E NÃO SE RESOLVE: a conversa mostrou em ${recebeu} rodada(s) e a\n` +
          `    lista acompanhou em ${listaOk}. Quem atende pela lista vê "sem mensagens" enquanto a\n` +
          `    mensagem já está aberta ao lado — e nada na tela avisa qual dos dois está velho.`,
  );
  if (fechar() > 0) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("❌ prova falhou:", err);
  process.exit(1);
});
