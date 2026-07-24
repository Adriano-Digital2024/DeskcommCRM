/**
 * Seed E2E do Radar de Risco (C1): um lead ABERTO cuja última atividade foi há 5
 * dias e SEM follow-up agendado — o caso "crítico / sem próximo passo" que o radar
 * existe para tornar visível. Alimenta tests/e2e/risk-radar.spec.ts.
 *
 * Idempotente: upsert por (organization_id, title). Depende de .e2e-creds.json
 * (rode scripts/seed-e2e-credentials.ts antes). Grava o bloco `radar` em .e2e-creds.json.
 *
 * Run: npx tsx scripts/seed-e2e-radar.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const AT_RISK_TITLE = "Demanda E2E em risco (radar)";

interface Creds {
  org_id: string;
  radar?: unknown;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;

  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (pErr || !pipeline) throw new Error(`default pipeline not found: ${pErr?.message}`);
  const pipelineId = (pipeline as { id: string }).id;

  const { data: stage, error: sErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position")
    .limit(1)
    .maybeSingle();
  if (sErr || !stage) throw new Error(`stage not found: ${sErr?.message}`);
  const stageId = (stage as { id: string }).id;

  // 5 dias sem atividade → crítico; sem contato/follow-up → "sem próximo passo".
  const coldAt = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();

  const { data: existing } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("title", AT_RISK_TITLE)
    .maybeSingle();

  let leadId: string;
  if (existing) {
    leadId = (existing as { id: string }).id;
    await admin
      .from("crm_leads")
      .update({ stage_id: stageId, owner_user_id: null, last_activity_at: coldAt } as never)
      .eq("id", leadId);
    console.log(`[seed] radar lead existing: ${leadId}`);
  } else {
    const { data, error } = await admin
      .from("crm_leads")
      .insert({
        organization_id: orgId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: AT_RISK_TITLE,
        owner_user_id: null,
        position_in_stage: 3000,
        source: "manual",
        last_activity_at: coldAt,
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert radar lead: ${error?.message}`);
    leadId = (data as { id: string }).id;
    console.log(`[seed] radar lead created: ${leadId}`);
  }

  creds.radar = { pipeline_id: pipelineId, at_risk_lead_id: leadId, at_risk_title: AT_RISK_TITLE };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.log(`\n✅ Radar seed completo. lead=${leadId} (frio desde ${coldAt})`);
}

main().catch((err) => {
  console.error("❌ Radar seed falhou:", err);
  process.exit(1);
});
