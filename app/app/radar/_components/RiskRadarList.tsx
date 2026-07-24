"use client";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAtRiskLeads, type AtRiskLead } from "@/hooks/leads/useAtRiskLeads";
import type { RiskBucket } from "@/lib/leads/risk-radar";
import {
  ArrowRight,
  CheckCircle,
  ClockCountdown,
  PaperPlaneTilt,
  Robot,
  Warning,
} from "@/lib/ui/icons";

const RISK_META: Record<
  Exclude<RiskBucket, "em_dia">,
  { label: string; variant: "error" | "warning" | "info" }
> = {
  critico: { label: "Crítico", variant: "error" },
  em_risco: { label: "Em risco", variant: "warning" },
  em_voo: { label: "Em voo", variant: "info" },
};

function coldFor(hours: number): string {
  if (hours < 48) return `parado há ${hours}h`;
  return `parado há ${Math.round(hours / 24)}d`;
}

function followupWhen(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "agora";
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 48) return `em ${Math.max(1, hours)}h`;
  return `em ${Math.round(hours / 24)}d`;
}

export function RiskRadarList() {
  const { data, isLoading } = useAtRiskLeads();

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!data || data.total === 0) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"
        data-testid="radar-empty"
      >
        <CheckCircle size={28} className="text-success-fg/70" aria-hidden />
        <p className="text-sm font-medium">Nenhuma demanda em risco</p>
        <p className="text-xs text-muted-foreground">
          Toda demanda aberta teve atividade recente ou já tem um retorno agendado.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap gap-2" data-testid="radar-counts">
        <Badge variant="error">{data.counts.critico} crítico</Badge>
        <Badge variant="warning">{data.counts.em_risco} em risco</Badge>
        <Badge variant="info">{data.counts.em_voo} em voo</Badge>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {data.items.map((lead) => (
          <RadarRow key={lead.id} lead={lead} />
        ))}
      </ul>
    </div>
  );
}

function RadarRow({ lead }: { lead: AtRiskLead }) {
  const meta = RISK_META[lead.risk as Exclude<RiskBucket, "em_dia">] ?? RISK_META.em_risco;
  const href = lead.conversation_id
    ? `/app/inbox?id=${lead.conversation_id}`
    : `/app/pipelines/${lead.pipeline_id}`;

  const assignee =
    lead.assignee_kind === "ai"
      ? { icon: <Robot size={13} aria-hidden />, text: "Assistente" }
      : lead.owner_user_id || lead.assignee_kind === "user"
        ? { icon: null, text: "Com atendente" }
        : { icon: null, text: "Sem dono" };

  return (
    <li data-testid="radar-item" data-risk={lead.risk}>
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
      >
        <Badge variant={meta.variant} className="mt-0.5 shrink-0">
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{lead.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {lead.contact_name ? <span className="truncate">{lead.contact_name}</span> : null}
            <span className="inline-flex items-center gap-1">
              <ClockCountdown size={13} aria-hidden />
              {coldFor(lead.hours_since_activity)}
            </span>
            <span className="inline-flex items-center gap-1">
              {assignee.icon}
              {assignee.text}
            </span>
          </p>
          {lead.in_flight && lead.next_followup_at ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-info-fg">
              <PaperPlaneTilt size={13} aria-hidden />
              Assistente retorna {followupWhen(lead.next_followup_at)}
            </p>
          ) : (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-warning-fg">
              <Warning size={13} aria-hidden />
              Sem próximo passo agendado
            </p>
          )}
        </div>
        <ArrowRight size={16} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
