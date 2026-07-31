"use client";
import { Warning } from "@/lib/ui/icons";
import type { LgpdRequest } from "@/hooks/useLgpdRequests";

const TERMINAL_STATUSES = new Set(["completed", "failed", "expired"]);

interface SlaBannerProps {
  requests: LgpdRequest[];
}

export function SlaBanner({ requests }: SlaBannerProps) {
  const active = requests.filter((r) => !TERMINAL_STATUSES.has(r.status));

  const critical = active.filter(
    (r) => r.sla_bucket === "overdue" || r.sla_bucket === "critical",
  );
  const warning = active.filter((r) => r.sla_bucket === "warning");

  if (critical.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
      >
        <Warning size={18} weight="fill" className="shrink-0 text-red-600 dark:text-red-400" aria-hidden />
        <span>
          <strong>{critical.length}</strong>{" "}
          {critical.length === 1 ? "solicitação crítica" : "solicitações críticas"} —
          SLA vencido ou inferior a 2 dias. Ação imediata requerida.
        </span>
      </div>
    );
  }

  if (warning.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300"
      >
        <Warning size={18} weight="fill" className="shrink-0 text-yellow-600 dark:text-yellow-400" aria-hidden />
        <span>
          <strong>{warning.length}</strong>{" "}
          {warning.length === 1 ? "solicitação em alerta" : "solicitações em alerta"} —
          mais de 50% do prazo consumido.
        </span>
      </div>
    );
  }

  return null;
}
