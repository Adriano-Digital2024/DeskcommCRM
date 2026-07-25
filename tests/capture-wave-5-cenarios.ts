/**
 * WAVE 5 — CORE 3: score com evidência, e a faixa que não pode piscar.
 *
 * Duas exigências, e cada uma tem um jeito próprio de ficar verde à toa:
 *
 * A) A LEI MORA NO BANCO. "Score sem razão não é gravado" só vale se o Postgres
 *    REPROVAR. Ler o arquivo da migration prova que alguém escreveu a constraint;
 *    prova nenhuma de que ela foi aplicada, nem de que pega o caso do array
 *    vazio, que a própria migration nomeia como armadilha. Então aqui a
 *    verificação é uma TABELA-VERDADE contra o banco de verdade — e com a perna
 *    positiva: se tudo fosse recusado, "recusou" não distinguiria nada.
 *
 *    Escreve dentro de transação e faz ROLLBACK: constraint se testa tentando
 *    violar, e tentar violar num banco compartilhado sem desfazer é sujeira.
 *
 * B) A HISTERESE se testa com o valor DANÇANDO, não com o caso limpo. Mas
 *    "não pisca" não é a única propriedade: uma faixa que nunca muda também não
 *    pisca. Então são duas, e a segunda é a que o caso limpo não vê:
 *
 *      P1 — ANTI-PISCA: numa série oscilando em volta do limiar, a faixa muda no
 *           máximo uma vez.
 *      P2 — NÃO-MENTIRA: a faixa exibida nunca fica a DUAS faixas de distância da
 *           régua crua. Segurar uma faixa por um degrau é histerese; parar dois
 *           degraus atrás é rótulo velho — o card diria "Frio" ao lado de 72%.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-wave-5-cenarios.ts
 */

import * as fs from "node:fs";
import pg from "pg";

import { CREDS, carimbar } from "./qa-helpers";
import { resolveBand, type ScoreBand } from "@/lib/kanban/score-band";

const envFile = fs.readFileSync(".env.local", "utf8");
const envVars: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const pool = new pg.Pool({ connectionString: envVars.SUPABASE_DB_URL });
const ORG = CREDS.org_id as string;

type Estado = "PASS" | "FALHA" | "BLOQUEADO";
const resultados: { n: string; nome: string; estado: Estado; detalhe: string }[] = [];
function record(n: string, nome: string, ok: boolean, detalhe: string, estado?: Estado): void {
  const e: Estado = estado ?? (ok ? "PASS" : "FALHA");
  resultados.push({ n, nome, estado: e, detalhe });
  console.info(`${e.padEnd(9)} [${n}] ${nome} — ${detalhe}`);
}

// ---------------------------------------------------------------------------
// A) a tabela-verdade da constraint, contra Postgres real
// ---------------------------------------------------------------------------

interface Caso {
  n: string;
  nome: string;
  /** `true` = o banco TEM de recusar; `false` = tem de aceitar. */
  recusar: boolean;
  campos: Record<string, unknown>;
}

const LASTRO = { activity_ids: ["11111111-1111-1111-1111-111111111111"] };

const CASOS: Caso[] = [
  {
    n: "15.a",
    nome: "score COM razão e lastro é aceito",
    recusar: false,
    campos: { ai_probability: 72, ai_probability_reason: "dois compromissos e nenhuma objeção aberta", ai_probability_evidence: LASTRO },
  },
  {
    n: "15.b",
    nome: "score SEM razão é recusado",
    recusar: true,
    campos: { ai_probability: 72, ai_probability_reason: null, ai_probability_evidence: LASTRO },
  },
  {
    n: "15.c",
    nome: "razão só com espaços é recusada — string vazia não é razão",
    recusar: true,
    campos: { ai_probability: 72, ai_probability_reason: "   ", ai_probability_evidence: LASTRO },
  },
  {
    n: "15.d",
    nome: "razão sem lastro nenhum é recusada — razão sem referência é adjetivo",
    recusar: true,
    campos: { ai_probability: 72, ai_probability_reason: "parece quente", ai_probability_evidence: {} },
  },
  {
    n: "15.e",
    nome: "ARRAY VAZIO é recusado — lastro nenhum com cara de lastro",
    recusar: true,
    campos: { ai_probability: 72, ai_probability_reason: "parece quente", ai_probability_evidence: { activity_ids: [] } },
  },
  {
    n: "15.f",
    nome: "AUSÊNCIA de score é livre — sinal insuficiente é estado legítimo",
    recusar: false,
    campos: { ai_probability: null, ai_probability_reason: null, ai_probability_evidence: {} },
  },
  {
    n: "15.g",
    nome: "score fora de 0-100 é recusado",
    recusar: true,
    campos: { ai_probability: 101, ai_probability_reason: "acima do teto", ai_probability_evidence: LASTRO },
  },
  {
    n: "15.h",
    nome: "faixa fora do vocabulário é recusada",
    recusar: true,
    campos: { ai_probability: 72, ai_probability_reason: "ok", ai_probability_evidence: LASTRO, ai_probability_band: "morninho" },
  },
];

async function tabelaVerdade(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from crm_leads where organization_id = $1 and status = 'open' order by id limit 1`,
    [ORG],
  );
  const leadId = rows[0]?.id;
  if (!leadId) throw new Error("nenhum lead aberto na org — a tabela-verdade não se monta");

  const client = await pool.connect();
  try {
    // Tudo dentro de UMA transação desfeita no fim: a constraint é exercitada de
    // verdade e o banco compartilhado não guarda nada.
    await client.query("begin");
    for (const caso of CASOS) {
      await client.query("savepoint c");
      const chaves = Object.keys(caso.campos);
      const sets = chaves.map((k, i) => `${k} = $${i + 2}`).join(", ");
      const valores = chaves.map((k) => {
        const v = caso.campos[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      let erro: { code?: string; message?: string } | null = null;
      try {
        await client.query(`update crm_leads set ${sets} where id = $1`, [leadId, ...valores]);
      } catch (e) {
        erro = e as { code?: string; message?: string };
        await client.query("rollback to savepoint c");
      }
      const recusou = erro !== null;
      const constraint = (erro?.message ?? "").match(/"([a-z_]+)"/)?.[1] ?? "-";
      record(
        caso.n,
        caso.nome,
        recusou === caso.recusar,
        caso.recusar
          ? recusou
            ? `recusado por ${constraint} (${erro?.code})`
            : "ACEITO — a lei não está no banco, está só no comentário da migration"
          : recusou
            ? `RECUSADO indevidamente: ${erro?.code} ${constraint}`
            : "aceito, como tem de ser",
      );
    }
  } finally {
    await client.query("rollback").catch(() => null);
    client.release();
  }
}

// ---------------------------------------------------------------------------
// B) a histerese com o valor dançando
// ---------------------------------------------------------------------------

const ORDEM: ScoreBand[] = ["frio", "morno", "quente"];

interface Violacao {
  anterior: ScoreBand;
  score: number;
  obtido: ScoreBand;
  esperado: ScoreBand;
}

/**
 * Comprime scores CONSECUTIVOS com o mesmo veredito numa faixa.
 *
 * Não é cosmética: "70-74 vindo de frio exibem frio" mostra a FORMA do defeito
 * (a zona morta do limiar distante) — cinco linhas soltas mostram cinco casos e
 * deixam a forma para quem ler adivinhar.
 */
function comprimir(vs: Violacao[]): string {
  const grupos: string[] = [];
  let atual: { v: Violacao; de: number; ate: number } | null = null;
  const fechar = () => {
    if (!atual) return;
    const { v, de, ate } = atual;
    const faixa = de === ate ? `${de}` : `${de}-${ate}`;
    grupos.push(`vindo de "${v.anterior}", score ${faixa} exibe "${v.obtido}" (esperado "${v.esperado}")`);
    atual = null;
  };
  for (const v of vs) {
    if (
      atual &&
      atual.v.anterior === v.anterior &&
      atual.v.obtido === v.obtido &&
      atual.v.esperado === v.esperado &&
      v.score === atual.ate + 1
    ) {
      atual.ate = v.score;
      continue;
    }
    fechar();
    atual = { v, de: v.score, ate: v.score };
  }
  fechar();
  return grupos.join(" · ");
}

/**
 * ÂNCORAS — a cerca de regressão, escrita À MÃO a partir da regra declarada.
 *
 * Conserto que zera as violações quebrando os acertos é TROCA de defeito, não
 * correção — e a varredura sozinha não pega isso: devolver sempre a régua crua
 * zeraria a não-mentira e mataria a histerese inteira.
 *
 * Escritas a mão de propósito. Derivá-las de `porDegrau` ou de `faixaCrua` faria
 * a cerca concordar com o instrumento que ela deveria vigiar; cada linha aqui é
 * a régua do módulo lida por um humano e fixada como número.
 *
 * São as BORDAS — onde um conserto de um-a-mais/um-a-menos quebra: o primeiro
 * valor que confirma a mudança e o último que não confirma.
 */
const ANCORAS_DA_REGRA: {
  score: number;
  anterior: ScoreBand | null;
  esperado: ScoreBand;
  porque: string;
}[] = [
    { score: 72, anterior: null, esperado: "quente", porque: "sem memória, vale a régua crua" },
    { score: 50, anterior: null, esperado: "morno", porque: "sem memória, vale a régua crua" },
    { score: 10, anterior: null, esperado: "frio", porque: "sem memória, vale a régua crua" },
    { score: 45, anterior: "frio", esperado: "morno", porque: "primeiro valor que CONFIRMA a subida (40+5)" },
    { score: 44, anterior: "frio", esperado: "frio", porque: "último que NÃO confirma — a zona morta segura" },
    { score: 75, anterior: "morno", esperado: "quente", porque: "primeiro valor que CONFIRMA a subida (70+5)" },
    { score: 74, anterior: "morno", esperado: "morno", porque: "último que NÃO confirma" },
    { score: 65, anterior: "quente", esperado: "morno", porque: "primeiro valor que CONFIRMA a descida (70-5)" },
    { score: 66, anterior: "quente", esperado: "quente", porque: "último que NÃO confirma" },
    { score: 35, anterior: "morno", esperado: "frio", porque: "primeiro valor que CONFIRMA a descida (40-5)" },
    { score: 36, anterior: "morno", esperado: "morno", porque: "último que NÃO confirma" },
    { score: 50, anterior: "morno", esperado: "morno", porque: "no meio da faixa nada se mexe" },
    { score: 80, anterior: "frio", esperado: "quente", porque: "salto real atravessa duas faixas de uma vez" },
    { score: 20, anterior: "quente", esperado: "frio", porque: "tombo real atravessa duas faixas de uma vez" },
];

/**
 * A régua escrita no próprio módulo, aplicada degrau a degrau: "para SUBIR de
 * faixa o score precisa passar do limiar mais a banda; para DESCER, cair abaixo
 * do limiar menos a banda". Não é um modelo meu — é o comentário virado código,
 * que é o único jeito de confrontar os dois.
 */
function porDegrau(score: number, anterior: ScoreBand): ScoreBand {
  let b = anterior;
  for (let i = 0; i < ORDEM.length; i++) {
    let n = b;
    if (b === "frio" && score >= 45) n = "morno";
    else if (b === "morno" && score >= 75) n = "quente";
    else if (b === "quente" && score <= 65) n = "morno";
    else if (b === "morno" && score <= 35) n = "frio";
    if (n === b) break;
    b = n;
  }
  return b;
}
/** A faixa que o número indicaria sem memória nenhuma — a régua crua. */
function faixaCrua(score: number): ScoreBand {
  if (score >= 70) return "quente";
  if (score >= 40) return "morno";
  return "frio";
}

function histerese(): void {
  // P1 — o valor dançando em volta de CADA limiar, não de um só.
  for (const [nome, serie] of [
    ["limiar morno (40)", [38, 42, 39, 41, 38, 43, 40, 37]],
    ["limiar quente (70)", [68, 72, 69, 71, 68, 73, 70, 67]],
  ] as [string, number[]][]) {
    let banda: ScoreBand | null = null;
    const trocas: string[] = [];
    for (const s of serie) {
      const nova = resolveBand(s, banda);
      if (banda !== null && nova !== banda) trocas.push(`${s}:${banda}→${nova}`);
      banda = nova;
    }
    record(
      `16.${nome.includes("morno") ? "a" : "b"}`,
      `ANTI-PISCA no ${nome}: série oscilante muda a faixa no máximo uma vez`,
      trocas.length <= 1,
      trocas.length === 0
        ? `nenhuma troca em ${serie.length} recálculos — o card fica quieto`
        : `${trocas.length} troca(s): ${trocas.join(", ")}`,
    );
  }

  // P2 e P3 por VARREDURA, não por exemplos. Exemplo escolhido a mão acha o que
  // quem escreveu já suspeitava; a varredura acha o que ninguém suspeitou. Aqui o
  // domínio inteiro cabe num laço: 101 scores × 3 faixas anteriores = 303 casos,
  // e ainda sobra barato. Onde der para varrer o domínio, amostrar é escolha
  // pior — e a saída ainda comprime as violações em FAIXAS, porque 300 linhas de
  // falha escondem a forma do defeito tão bem quanto nenhuma linha.
  const violaP2: Violacao[] = [];
  const violaP3: Violacao[] = [];
  for (const anterior of ORDEM) {
    for (let score = 0; score <= 100; score++) {
      const exibida = resolveBand(score, anterior);
      const crua = faixaCrua(score);
      if (Math.abs(ORDEM.indexOf(exibida) - ORDEM.indexOf(crua)) >= 2) {
        violaP2.push({ anterior, score, obtido: exibida, esperado: crua });
      }
      const degrau = porDegrau(score, anterior);
      if (exibida !== degrau) {
        violaP3.push({ anterior, score, obtido: exibida, esperado: degrau });
      }
    }
  }

  record(
    "16.c",
    "NÃO-MENTIRA em TODO o domínio: 303 casos, faixa nunca a duas da régua crua",
    violaP2.length === 0,
    violaP2.length === 0
      ? "0..100 × 3 faixas anteriores — nenhum caso passou de um degrau de atraso"
      : `${violaP2.length}/303 casos: ${comprimir(violaP2)}`,
  );
  record(
    "16.d",
    "a função concorda com a régua escrita no módulo — em TODO o domínio",
    violaP3.length === 0,
    violaP3.length === 0
      ? "0..100 × 3 faixas anteriores — função e régua escrita coincidem"
      : `${violaP3.length}/303 casos: ${comprimir(violaP3)}`,
  );

  const quebradas = ANCORAS_DA_REGRA.filter((a) => resolveBand(a.score, a.anterior) !== a.esperado).map(
    (a) =>
      `${a.score} de "${a.anterior ?? "(sem memória)"}" deu "${resolveBand(a.score, a.anterior)}", esperado "${a.esperado}" (${a.porque})`,
  );
  record(
    "16.e",
    "ÂNCORAS: o que já funciona continua funcionando depois do conserto",
    quebradas.length === 0,
    quebradas.length === 0
      ? `${ANCORAS_DA_REGRA.length} bordas fixadas à mão, todas de pé`
      : `${quebradas.length}/${ANCORAS_DA_REGRA.length} quebrada(s): ${quebradas.join(" · ")}`,
  );
}


/**
 * AUTO-TESTE DA CERCA — `SELFCHECK=1`.
 *
 * A 16.e passa hoje, antes de qualquer conserto. Isso é o que se pede dela, e é
 * também o que a torna suspeita: cerca que nunca reprovou pode ser decoração.
 * Então aqui ela é submetida ao conserto ERRADO que o regente nomeou — o que
 * zera as violações matando a histerese: devolver sempre a régua crua.
 *
 * Não mexo em `lib/kanban/score-band.ts` para fazer isto. O arquivo está sendo
 * escrito pelo @DevVivo agora, e mutilar arquivo de colega vivo é a receita de
 * dois trabalhos se destruírem. A regra alternativa é local a esta função.
 */
function autoTesteDaCerca(): void {
  const ingenua = (score: number, _anterior: ScoreBand | null): ScoreBand => faixaCrua(score);

  const violaP2 = ORDEM.flatMap((anterior) =>
    Array.from({ length: 101 }, (_, score) => score).filter(
      (score) =>
        Math.abs(ORDEM.indexOf(ingenua(score, anterior)) - ORDEM.indexOf(faixaCrua(score))) >= 2,
    ),
  ).length;

  let banda: ScoreBand | null = null;
  let trocas = 0;
  for (const s of [68, 72, 69, 71, 68, 73, 70, 67]) {
    const nova = ingenua(s, banda);
    if (banda !== null && nova !== banda) trocas++;
    banda = nova;
  }

  const ancorasQuebradas = ANCORAS_DA_REGRA.filter(
    (a) => ingenua(a.score, a.anterior) !== a.esperado,
  ).length;

  console.info("\n=== AUTO-TESTE: a cerca reprova o conserto que mata a histerese? ===");
  console.info(`  a régua crua zera a NÃO-MENTIRA (16.c): ${violaP2} violações`);
  console.info(`  ...e o ANTI-PISCA a reprova: ${trocas} trocas na série oscilante (limite 1)`);
  console.info(`  ...e as ÂNCORAS a reprovam: ${ancorasQuebradas}/${ANCORAS_DA_REGRA.length} quebradas`);
  const cercaFunciona = violaP2 === 0 && (trocas > 1 || ancorasQuebradas > 0);
  console.info(
    cercaFunciona
      ? "  ==> CERCA DE PÉ: o atalho passaria na varredura e é barrado pelas outras duas."
      : "  ==> CERCA FURADA: o atalho passaria — a 16.e não distingue conserto de troca de defeito.",
  );
  if (!cercaFunciona) process.exitCode = 1;
}

async function main(): Promise<void> {
  carimbar([
    "supabase/migrations/20260725040000_0074_lead_score_com_evidencia.sql",
    "lib/kanban/score-band.ts",
    "lib/kanban/card-state.ts",
    "components/kanban/KanbanCard.tsx",
  ]);

  if (process.env.SELFCHECK === "1") {
    autoTesteDaCerca();
    return;
  }

  try {
    await tabelaVerdade();
    histerese();
  } finally {
    await pool.end().catch(() => null);
  }

  const pass = resultados.filter((r) => r.estado === "PASS").length;
  const falha = resultados.filter((r) => r.estado === "FALHA").length;
  const bloq = resultados.filter((r) => r.estado === "BLOQUEADO").length;
  console.info(`\n=== WAVE 5: ${pass} verdes · ${falha} vermelhos · ${bloq} bloqueados ===`);
  for (const r of resultados.filter((x) => x.estado !== "PASS")) {
    console.info(`  ${r.estado} [${r.n}] ${r.nome}: ${r.detalhe}`);
  }
  if (falha > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("❌ Wave 5 falhou:", err);
  await pool.end().catch(() => null);
  process.exit(1);
});
