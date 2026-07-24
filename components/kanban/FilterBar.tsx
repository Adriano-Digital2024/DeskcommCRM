"use client";
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAssignableAgents } from "@/hooks/kanban/useAssignableAgents";
import type { Lead } from "@/lib/types/leads";
import {
  agentOwnerFilter,
  parseAgentOwnerFilter,
  type LeadFilters,
} from "@/lib/kanban/filters";
import { cn } from "@/lib/utils";

interface FilterBarProps {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  leads: Lead[];
}

const STATUS_OPTIONS: Array<{ value: NonNullable<LeadFilters["status"]>; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "open", label: "Abertos" },
  { value: "won", label: "Ganhos" },
  { value: "lost", label: "Perdidos" },
];

export function FilterBar({ filters, onChange, leads }: FilterBarProps) {
  const user = useUser();
  const { data: members } = useAssignableMembers(true);
  const { data: agents } = useAssignableAgents(true);
  const [searchInput, setSearchInput] = useState(filters.search ?? "");

  // Debounce search 250ms
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.search ?? "") !== searchInput) {
        onChange({ ...filters, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) for (const t of l.tags) set.add(t);
    return Array.from(set).sort();
  }, [leads]);

  const filteredAgentId = parseAgentOwnerFilter(filters.owner);
  const ownerLabel =
    filters.owner === "unassigned"
      ? "Sem responsável"
      : !filters.owner || filters.owner === "any"
        ? "Todos"
        : filteredAgentId
          ? (agents?.find((a) => a.agent_id === filteredAgentId)?.name ?? "Agente")
          : filters.owner === user.id
            ? "Eu"
            : (members?.find((m) => m.user_id === filters.owner)?.full_name ??
              "Responsável");

  const statusLabel =
    STATUS_OPTIONS.find((o) => o.value === (filters.status ?? "all"))?.label ?? "Todos";

  const tagLabel = filters.tag ?? "Tag: todas";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
      <Input
        type="search"
        placeholder="Buscar por título…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className="h-9 w-64"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">Responsável: {ownerLabel}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Responsável</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: "any" })}>
            Todos
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: "unassigned" })}>
            Sem responsável
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: user.id })}>
            Eu
          </DropdownMenuItem>
          {members && members.filter((m) => m.user_id !== user.id).length > 0 && (
            <>
              <DropdownMenuSeparator />
              {members
                .filter((m) => m.user_id !== user.id)
                .map((m) => (
                  <DropdownMenuItem
                    key={m.user_id}
                    onClick={() => onChange({ ...filters, owner: m.user_id })}
                  >
                    {m.full_name ?? "Sem nome"}
                  </DropdownMenuItem>
                ))}
            </>
          )}
          {/* Agentes na MESMA lista dos humanos: o dono é um só campo. */}
          {agents && agents.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {agents.map((a) => (
                <DropdownMenuItem
                  key={a.agent_id}
                  onClick={() => onChange({ ...filters, owner: agentOwnerFilter(a.agent_id) })}
                >
                  {a.name}
                  {a.version_number != null && (
                    <span className="ml-1.5 font-mono text-[10px] text-text-muted">
                      v{a.version_number}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">Status: {statusLabel}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUS_OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => onChange({ ...filters, status: o.value })}
            >
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={tagOptions.length === 0}>
            {tagLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onChange({ ...filters, tag: undefined })}>
            Todas
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {tagOptions.map((t) => (
            <DropdownMenuItem key={t} onClick={() => onChange({ ...filters, tag: t })}>
              {t}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <label
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
          filters.overdueOnly && "border-accent bg-accent/10",
        )}
      >
        <input
          type="checkbox"
          checked={!!filters.overdueOnly}
          onChange={(e) => onChange({ ...filters, overdueOnly: e.target.checked })}
        />
        Apenas atrasados
      </label>

      {(filters.search ||
        filters.owner ||
        filters.tag ||
        filters.overdueOnly ||
        (filters.status && filters.status !== "all")) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearchInput("");
            onChange({ status: "all" });
          }}
        >
          Limpar filtros
        </Button>
      )}
    </div>
  );
}
