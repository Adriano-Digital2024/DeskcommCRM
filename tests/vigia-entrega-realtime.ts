/**
 * VIGIA: a entrega ainda está viva, e desde quando?
 *
 * O defeito sumiu sem ninguém ter consertado — e defeito que some sozinho volta
 * sozinho. Hoje eu só consegui cercar o INÍCIO do silêncio porque tinha, por
 * acaso, um veredito verde datado (a wave 6 fechando 13/0/0 às 11:41) e um
 * vermelho datado meia hora depois. A janela de 31 minutos foi sorte de registro,
 * não instrumento.
 *
 * Este vigia troca a sorte por um relógio: mede a entrega dos DOIS pipelines de
 * tempos em tempos e escreve uma linha por ciclo. Se o defeito voltar, a
 * transição fica com hora — em vez de ser descoberta de novo por acidente, e
 * datada por aproximação.
 *
 * DESENHO, e cada escolha tem motivo:
 *   - assinatura SEM FILTRO, porque filtro é uma variável a menos e foi
 *     levantado como diferença possível entre a minha medição e a do @DevVivo;
 *   - o pipeline saudável em TODO ciclo, intercalado, como controle positivo:
 *     um ciclo em que ele também não entrega não acusa ninguém, e é registrado
 *     como INDECIDÍVEL em vez de virar "o defeito voltou";
 *   - cliente novo por medição, porque cliente reaproveitado já me deu zeros que
 *     não se reproduziram;
 *   - volume declarado: 2 escritas por ciclo, apagadas em seguida.
 *
 * Run: CICLOS=12 INTERVALO_MIN=5 npx tsx tests/vigia-entrega-realtime.ts
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CREDS, carimbar } from "./qa-helpers";

const env: Record<string, string> = {};
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const ORG = CREDS.org_id as string;
const SAUDAVEL = "48c02b4a-0ca1-4bca-8ef0-206b6d240d23";
const DOENTE = "35bf4ac9-c5e0-4f7d-846a-99b1bcc92d69";
const RUN = randomUUID().slice(0, 6);
const LOG = path.join(process.cwd(), "evidence", "vigia-entrega.log");

async function mede(leadId: string, etiqueta: string): Promise<boolean> {
  const cli = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const marca = `${RUN}-${etiqueta}-${Date.now() % 1000000}`;
  let chegou = false;
  const canal = cli
    .channel(`vigia-${marca}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "crm_lead_activities" },
      (p: { new?: Record<string, unknown> }) => {
        if (String(p.new?.reason ?? "") === marca) chegou = true;
      },
    );
  const st = await new Promise<string>((r) => canal.subscribe((s) => r(s)));
  if (st !== "SUBSCRIBED") {
    await cli.removeAllChannels();
    return false;
  }
  await new Promise((r) => setTimeout(r, 2000));
  const { error } = await admin.from("crm_lead_activities").insert({
    organization_id: ORG,
    lead_id: leadId,
    source_module: "qa",
    type: "note",
    actor_kind: "system",
    reason: marca,
    evidence: {},
    performed_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`vigia ${etiqueta}: ${error.message}`);
  await new Promise((r) => setTimeout(r, 7000));
  await admin.from("crm_lead_activities").delete().eq("reason", marca);
  await cli.removeAllChannels();
  return chegou;
}

async function main(): Promise<void> {
  carimbar(["tests/vigia-entrega-realtime.ts"]);
  const CICLOS = Number(process.env.CICLOS ?? "12");
  const INTERVALO = Number(process.env.INTERVALO_MIN ?? "5") * 60_000;
  const { data: b } = await admin.from("crm_leads").select("id").eq("pipeline_id", SAUDAVEL).order("id").limit(1);
  const { data: d } = await admin
    .from("crm_leads")
    .select("id")
    .eq("pipeline_id", DOENTE)
    .order("created_at")
    .limit(1);
  const bom = (b ?? [])[0] as { id: string };
  const doente = (d ?? [])[0] as { id: string };
  console.info(`[vigia] ${CICLOS} ciclos a cada ${INTERVALO / 60000}min · log em ${LOG}`);

  for (let i = 1; i <= CICLOS; i++) {
    const okBom = await mede(bom.id, "saudavel");
    const okDoente = await mede(doente.id, "doente");
    const hora = new Date().toTimeString().slice(0, 8);
    // O CONTROLE DECIDE A LEITURA DO CICLO. Sem ele, um ciclo em que nada
    // entrega viraria "o defeito voltou" — e seria o mesmo par caído que eu já
    // descartei uma vez hoje, agora escrito num log que ninguém vai reauditar.
    const leitura = !okBom
      ? "INDECIDÍVEL (nem o controle entregou)"
      : okDoente
        ? "os dois entregam"
        : "*** O DEFEITO VOLTOU: controle entrega, doente não ***";
    const linha = `${hora} ciclo ${String(i).padStart(2)} · saudável=${okBom ? "ok" : "FALHOU"} · doente=${okDoente ? "ok" : "FALHOU"} · ${leitura}`;
    console.info(`  ${linha}`);
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${linha}\n`);
    if (i < CICLOS) await new Promise((r) => setTimeout(r, INTERVALO));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ vigia falhou:", err);
  process.exit(1);
});
