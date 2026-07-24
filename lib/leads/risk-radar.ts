/**
 * Radar de Risco (desilhamento C1 da doutrina do sistema vivo) — lógica pura de
 * classificação. Uma demanda aberta que esfriou e não tem próximo passo garantido
 * está morrendo sem ninguém ver; o radar a torna visível. Ver docs/doctrine/sistema-vivo.md.
 *
 * Regra: se a IA agendou um follow-up (in_flight), o sistema ainda a mantém viva —
 * "em voo". Sem follow-up e fria = "em risco"; muito fria = "crítico". Fresca (< janela
 * mínima) sai do radar: nada a fazer ainda.
 */

export type RiskBucket = "critico" | "em_risco" | "em_voo" | "em_dia";

// ponytail: janelas fixas; viram knob por pipeline (settings.fields) se um tenant pedir.
export const RISK_COLD_HOURS = 24;
export const RISK_CRITICAL_HOURS = 72;

export interface RiskInput {
  /** last_activity_at do lead (ou created_at se nunca teve atividade). */
  lastActivityAt: Date;
  now: Date;
  /** há follow-up agendado no futuro (cron_jobs kind='at' enabled) para o contato. */
  inFlight: boolean;
}

export interface RiskResult {
  bucket: RiskBucket;
  hoursSinceActivity: number;
  /** entra no radar? em_dia (fresca e sem risco) fica de fora. */
  onRadar: boolean;
}

export function classifyRisk({ lastActivityAt, now, inFlight }: RiskInput): RiskResult {
  const hoursSinceActivity = Math.max(
    0,
    (now.getTime() - lastActivityAt.getTime()) / 3_600_000,
  );
  let bucket: RiskBucket;
  if (hoursSinceActivity < RISK_COLD_HOURS) {
    bucket = "em_dia";
  } else if (inFlight) {
    bucket = "em_voo";
  } else if (hoursSinceActivity >= RISK_CRITICAL_HOURS) {
    bucket = "critico";
  } else {
    bucket = "em_risco";
  }
  return { bucket, hoursSinceActivity, onRadar: bucket !== "em_dia" };
}

/** Ordem de triagem: crítico primeiro, depois em risco, depois em voo. */
const BUCKET_RANK: Record<RiskBucket, number> = {
  critico: 0,
  em_risco: 1,
  em_voo: 2,
  em_dia: 3,
};

/** Ordena por bucket e, dentro do bucket, o mais frio primeiro. */
export function compareRisk(
  a: { bucket: RiskBucket; hoursSinceActivity: number },
  b: { bucket: RiskBucket; hoursSinceActivity: number },
): number {
  const byBucket = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
  return byBucket !== 0 ? byBucket : b.hoursSinceActivity - a.hoursSinceActivity;
}
