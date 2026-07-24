"use client";
import { Draggable } from "@hello-pangea/dnd";
import type { MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { OwnerDisplay } from "@/lib/kanban/owner";
import { KanbanCardActions } from "./KanbanCardActions";
import { OwnerBadge } from "./OwnerBadge";

interface KanbanCardProps {
  lead: Lead;
  index: number;
  pipelineId: string;
  /** Dono já resolvido no board (humano ou agente) — ver lib/kanban/owner.ts. */
  owner?: OwnerDisplay;
  isSelected?: boolean;
  onSelect?: (leadId: string, additive: boolean) => void;
}

function formatBRL(cents: number | null, currency: string | null): string | null {
  if (cents == null) return null;
  const code = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

export function KanbanCard({
  lead,
  index,
  pipelineId,
  owner,
  isSelected,
  onSelect,
}: KanbanCardProps) {
  const value = formatBRL(lead.value_cents, lead.currency);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    const additive = e.metaKey || e.ctrlKey;
    onSelect(lead.id, additive);
  };

  return (
    <Draggable draggableId={lead.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={handleClick}
          className={cn(
            "group rounded-md border border-border bg-surface p-3 shadow-xs transition-colors",
            "hover:border-border-strong",
            snapshot.isDragging && "rotate-1 shadow-md ring-1 ring-accent/40",
            isSelected && "ring-2 ring-accent",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-sm font-medium leading-snug text-text">
              {lead.title}
            </h3>
            <KanbanCardActions lead={lead} pipelineId={pipelineId} />
          </div>

          {value && (
            <p className="mt-2 text-xs font-medium tabular-nums text-text-muted">
              {value}
            </p>
          )}

          {lead.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {lead.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px]">
                  {tag}
                </Badge>
              ))}
              {lead.tags.length > 3 && (
                <span className="text-[10px] text-text-muted">
                  +{lead.tags.length - 3}
                </span>
              )}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <OwnerBadge
              ownerKind={owner?.kind ?? null}
              ownerName={owner?.name ?? null}
              agentVersion={owner?.agentVersion ?? null}
            />
          </div>
        </div>
      )}
    </Draggable>
  );
}
