"use client";
import { Draggable } from "@hello-pangea/dnd";
import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import { resolveCardState, stageAgeLabel, type CardInput } from "@/lib/kanban/card-state";
import { KanbanCardActions } from "./KanbanCardActions";
import { OwnerBadge } from "./OwnerBadge";

interface KanbanCardProps {
  /** O que o card mostra — explicitamente NÃO é a linha do banco. */
  card: CardInput;
  /** A linha do lead, só para o menu de ações (que muta o lead). */
  lead: Lead;
  index: number;
  pipelineId: string;
  isSelected?: boolean;
  /** Chegou por evento REMOTO agora — pulsa uma vez e cessa (Wave 3). */
  pulse?: boolean;
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

/**
 * O card do Kanban — orçamento FIXO: 5 elementos, 3 faixas, altura constante.
 *
 * As alturas são reservadas em vez de derivadas do conteúdo: título sempre
 * ocupa 2 linhas, valor sempre ocupa a sua linha (com "—" quando não há valor),
 * e a faixa do agente existe mesmo vazia. É isso que faz o board continuar
 * legível quando score, próxima ação e alerta chegarem — o card não cresce com
 * dados, ele TROCA de estado.
 *
 * Cor só aparece na borda esquerda, e só quando o estado pede (Lei C).
 */
export function KanbanCard({
  card,
  lead,
  index,
  pipelineId,
  isSelected,
  pulse,
  onSelect,
}: KanbanCardProps) {
  const value = formatBRL(card.valueCents, card.currency);
  const state = resolveCardState(card);
  const age = stageAgeLabel(card.hoursInStage);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    const additive = e.metaKey || e.ctrlKey;
    onSelect(card.id, additive);
  };

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          // O dnd marca o handle como role="button"; com o menu de ações dentro,
          // isso vira nested-interactive no axe. "group" mantém o foco e o
          // teclado do dnd (tabIndex e handlers continuam vindo do spread) sem
          // aninhar dois controles — nada de aria-hidden nem de suprimir regra.
          role="group"
          aria-label={`Lead: ${card.title}`}
          onClick={handleClick}
          // Tags saem do card (Lei A): ficam a um hover, sem ocupar altura.
          title={card.tags.length > 0 ? `Tags: ${card.tags.join(", ")}` : undefined}
          className={cn(
            "group relative overflow-hidden rounded-md border border-border bg-surface",
            "py-2.5 pl-3 pr-3 shadow-xs transition-colors",
            "hover:border-border-strong",
            snapshot.isDragging && "rotate-1 shadow-md ring-1 ring-accent/40",
            isSelected && "ring-2 ring-accent",
            pulse && "card-pulse",
          )}
        >
          {/* Borda de estado — 2px, a única cor do card. */}
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-0.5",
              state.border === "accent" && "bg-accent",
              state.border === "warning" && "bg-warning",
              state.border === "neutral" && "bg-transparent",
            )}
          />

          {/* ① identidade — altura FIXA de 2 linhas, com ou sem texto longo. */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-1.5">
              {card.canonicalTag && (
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  title={card.canonicalTag}
                  // role="img": um span nu não aceita aria-label (aria-prohibited-attr).
                  role="img"
                  aria-label={`Tag: ${card.canonicalTag}`}
                />
              )}
              <h3 className="line-clamp-2 h-10 text-sm font-medium leading-5 text-text">
                {card.title}
              </h3>
            </div>
            <KanbanCardActions lead={lead} pipelineId={pipelineId} />
          </div>

          {/* ② valor — altura reservada mesmo sem valor, senão o card encolhe. */}
          <p
            className={cn(
              "mt-1 h-5 text-xs font-medium leading-5 tabular-nums",
              value ? "text-text" : "text-text-muted",
            )}
          >
            {value ?? "—"}
          </p>

          {/* ③ a linha do agente — um slot, três estados, nunca três blocos. */}
          <div className="mt-1.5 flex h-6 items-center gap-2 text-xs">
            {state.slot.type === "awaiting" && (
              <span className="truncate text-accent">Propõe: {state.slot.label}</span>
            )}
            {state.slot.type === "cooling" && (
              // -fg é a variante de TEXTO do token (o -warning puro dá 3.7:1 em
              // 12px); a cor cheia fica na borda de estado, que é gráfica.
              <span className="truncate text-warning-fg">{state.slot.label}</span>
            )}
            {state.slot.type === "meter" && (
              <>
                <span
                  className="h-[3px] w-16 shrink-0 overflow-hidden rounded-full bg-border"
                  aria-hidden
                >
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${state.slot.probability}%` }}
                  />
                </span>
                <span className="tabular-nums text-text-muted">
                  {state.slot.probability}%
                </span>
              </>
            )}
          </div>

          {/* ④ dono · ⑤ tempo no estágio */}
          <div className="mt-1 flex h-6 items-center justify-between gap-2">
            <OwnerBadge
              ownerKind={card.owner.kind}
              ownerName={card.owner.name}
              agentVersion={card.owner.agentVersion}
            />
            <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-text-muted">
              {state.showStageAge && age ? `${age} em ${card.stageName}` : `em ${card.stageName}`}
            </span>
          </div>
        </div>
      )}
    </Draggable>
  );
}
