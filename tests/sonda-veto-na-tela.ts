/**
 * Sonda do orquestrador — cenário 11: a decisão de NÃO enviar aparece na tela?
 *
 * O cenário mistura duas coisas, e elas têm provas diferentes:
 *   A DECISÃO de vetar  -> já provada pelo invariante (veto-activity.test.ts),
 *                          que roda o código real contra Postgres real.
 *   A EXIBIÇÃO do veto  -> nunca provada, porque NUNCA houve um veto neste
 *                          banco: zero linhas `send_vetoed`, zero
 *                          `agent.activity_unrouted`.
 *
 * Provocar um veto de verdade exigiria um turno completo do agente batendo num
 * gate. Caro, e não é o que falta — o que falta é a linha existir para a tela
 * ter o que mostrar.
 *
 * Então esta sonda chama `emitVetoActivity`, **o emissor de produção**, com um
 * pool real. A linha nasce do mesmo código que nasceria num veto de verdade:
 * a exibição fica honestamente provada, sem encenar a decisão. Escrever a linha
 * com INSERT à mão provaria a tela e mentiria sobre a origem.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-veto-na-tela.ts
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { chromium } from "@playwright/test";
import pg from "pg";

import { emitVetoActivity } from "@/lib/leads/veto-activity";
import { BASE, EVIDENCE, login, shotPage } from "./qa-helpers";

const envFile = fs.readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

/**
 * A org do admin de e2e. Pegar "qualquer lead aberto" traria contato de OUTRO
 * tenant: o veto seria emitido, a página do contato não abriria, e a sonda
 * reprovaria a tela por um motivo que não é o dela.
 */
const ORG_E2E = "6e567068-fd1c-4f94-ae1f-40e0334be190";

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL });

  // Contato que TEM negócio aberto — senão o veto cai em `activity_unrouted`
  // (o comportamento correto quando não há onde pendurar) e não haveria linha
  // na timeline para olhar. O alvo é o caso roteado.
  const { rows } = await pool.query(
    `select l.organization_id, l.contact_id, l.id as lead_id
       from crm_leads l
      where l.contact_id is not null and l.status = 'open'
        and l.organization_id = $1
      limit 1`,
    [ORG_E2E],
  );
  const alvo = rows[0];
  if (!alvo) throw new Error("sem lead aberto com contato");

  const { rows: agentes } = await pool.query(
    `select id from ai_agents where organization_id = $1 limit 1`,
    [alvo.organization_id],
  );

  // UUID de verdade: o ponteiro de origem mora em coluna uuid.
  const traceId = randomUUID();
  const r = await emitVetoActivity({
    pool,
    organizationId: alvo.organization_id,
    contactId: alvo.contact_id,
    traceId,
    gate: "pacing",
    code: "rate_limited",
    agentId: agentes[0]?.id ?? null,
  });
  console.info(`emissor de produção devolveu: ${JSON.stringify(r)}`);

  const browser = await chromium.launch();
  const page = await browser
    .newContext({ viewport: { width: 1440, height: 900 } })
    .then((c) => c.newPage());
  await login(page, "admin");
  await page.goto(`${BASE}/app/contacts/${alvo.contact_id}`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Timeline" }).click();

  const painel = page.locator("main");
  await painel
    .getByText(/Envio bloqueado|Nenhuma atividade registrada/)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  const texto = await painel.innerText();
  await shotPage(page, "wave-3-c11-veto-na-tela.png");

  const rotulado = /Envio bloqueado/.test(texto);
  const comMotivo = /pacing|limite|ritmo|bloqueado/i.test(texto);
  const semUuid = !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(texto);

  console.info(`rótulo em pt-BR ("Envio bloqueado"): ${rotulado ? "SIM" : "NÃO"}`);
  console.info(`motivo legível na linha: ${comMotivo ? "SIM" : "NÃO"}`);
  console.info(`sem UUID visível: ${semUuid ? "SIM" : "NÃO"}`);
  console.info(`print: ${EVIDENCE}/wave-3-c11-veto-na-tela.png`);

  await browser.close();
  await pool.end();
  if (!(rotulado && semUuid)) process.exitCode = 1;
}

void main();
