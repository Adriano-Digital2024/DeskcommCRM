import { Badge } from "@/components/ui/badge";
import type { OwnerKind } from "@/lib/types/leads";

/** Iniciais a partir do nome (primeira + última palavra). */
export function ownerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Exibe o responsável (owner) de um lead — humano ou agente de IA (0070).
 * Presentacional e sem dnd, testável em isolamento.
 *
 * O agente é PAR do humano, não um enfeite: mesmo diâmetro, mesmo peso, mesma
 * posição. A única diferença é a forma — humano = disco preenchido; agente =
 * círculo vazado com anel e inicial em mono. Nada de emoji, badge "AI"
 * colorido ou gradiente: a distinção é geométrica, não decorativa, e por isso
 * sobrevive ao daltonismo e ao teste do metro.
 */
export function OwnerBadge({
  ownerKind,
  ownerName,
  agentVersion,
}: {
  ownerKind: OwnerKind;
  ownerName: string | null;
  /** Versão publicada do agente no momento da exibição (nunca congelada no lead). */
  agentVersion?: number | null;
}) {
  if (!ownerKind) {
    return (
      <Badge
        variant="outline"
        className="border-dashed px-2 text-text-muted"
        aria-label="Sem responsável"
      >
        Sem responsável
      </Badge>
    );
  }

  const isAgent = ownerKind === "ai";
  const label = ownerName ?? (isAgent ? "Agente" : "Responsável");
  const versionSuffix = isAgent && agentVersion != null ? ` · v${agentVersion}` : "";
  const fullLabel = `${label}${versionSuffix}`;

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`Responsável: ${fullLabel}`}
      title={fullLabel}
    >
      <span
        className={
          isAgent
            ? "flex h-6 w-6 items-center justify-center rounded-full border border-accent font-mono text-[10px] font-semibold text-accent ring-1 ring-inset ring-accent/40"
            : "flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent"
        }
        aria-hidden
      >
        {ownerName ? ownerInitials(ownerName) : "?"}
      </span>
      <span className="max-w-[9rem] truncate text-xs text-text-muted">{label}</span>
    </div>
  );
}
