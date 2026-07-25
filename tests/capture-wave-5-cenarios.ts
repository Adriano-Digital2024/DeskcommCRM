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

  // P2 — a que o caso limpo não enxerga: a faixa exibida pode ficar UM degrau
  // atrás (é o preço da histerese); dois degraus não é histerese, é rótulo velho.
  const saltos: { score: number; anterior: ScoreBand }[] = [
    { score: 72, anterior: "frio" },
    { score: 74, anterior: "frio" },
    { score: 38, anterior: "quente" },
    { score: 36, anterior: "quente" },
    { score: 80, anterior: "frio" },
    { score: 20, anterior: "quente" },
  ];
  const mentiras: string[] = [];
  for (const s of saltos) {
    const exibida = resolveBand(s.score, s.anterior);
    const distancia = Math.abs(ORDEM.indexOf(exibida) - ORDEM.indexOf(faixaCrua(s.score)));
    if (distancia >= 2) {
      mentiras.push(
        `score ${s.score} vindo de "${s.anterior}" exibe "${exibida}" (régua crua: "${faixaCrua(s.score)}")`,
      );
    }
  }
  record(
    "16.c",
    "NÃO-MENTIRA: a faixa nunca fica a duas faixas da régua crua",
    mentiras.length === 0,
    mentiras.length === 0
      ? `${saltos.length} saltos conferidos, nenhum passou de um degrau de atraso`
      : `${mentiras.length} caso(s): ${mentiras.join(" · ")}`,
  );

  // A régua do módulo diz, palavra por palavra: "para SUBIR de faixa o score
  // precisa passar do limiar mais a banda; para DESCER, precisa cair abaixo do
  // limiar menos a banda". Aplicada degrau a degrau, ela dá outra resposta que a
  // função nos mesmos casos — e quando o comentário e o código discordam, um dos
  // dois está errado.
  const porDegrau = (score: number, anterior: ScoreBand): ScoreBand => {
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
  };
  const divergem = saltos
    .filter((s) => resolveBand(s.score, s.anterior) !== porDegrau(s.score, s.anterior))
    .map(
      (s) =>
        `${s.score}/${s.anterior}: função="${resolveBand(s.score, s.anterior)}" regra escrita="${porDegrau(s.score, s.anterior)}"`,
    );
  record(
    "16.d",
    "a função concorda com a regra escrita no próprio módulo",
    divergem.length === 0,
    divergem.length === 0 ? "nenhuma divergência nos saltos" : divergem.join(" · "),
  );
}

async function main(): Promise<void> {
  carimbar([
    "supabase/migrations/20260725040000_0074_lead_score_com_evidencia.sql",
    "lib/kanban/score-band.ts",
    "lib/kanban/card-state.ts",
    "components/kanban/KanbanCard.tsx",
  ]);

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
