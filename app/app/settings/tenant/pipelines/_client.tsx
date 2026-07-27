"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import type { PipelineConfigPatch } from "@/lib/schemas/settings";
import { AgentMappingSection } from "./_mapping";

export interface PipelineRow {
  id: string;
  name: string;
  slug: string;
  vocabulary: Record<string, string> | null;
  settings: Record<string, unknown> | null;
}

interface CustomFieldDef {
  key: string;
  label: string;
  type: string;
  required?: boolean;
}

function readFields(settings: Record<string, unknown> | null): CustomFieldDef[] {
  if (!settings) return [];
  const f = (settings as { fields?: unknown }).fields;
  return Array.isArray(f) ? (f as CustomFieldDef[]) : [];
}

function readLostReasons(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  return Array.isArray(r) ? (r as string[]) : [];
}

export function PipelinesClient({
  pipelines,
  podeEditarConfig,
}: {
  pipelines: PipelineRow[];
  /** Vocabulário/custom fields são admin (a server action recusa o resto). */
  podeEditarConfig: boolean;
}) {
  if (pipelines.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        Nenhum funil ativo. Crie um no quadro para poder configurá-lo aqui.
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {pipelines.map((p) => (
        <Card key={p.id} className="space-y-6 p-6">
          <header>
            <h2 className="text-base font-semibold">{p.name}</h2>
            <p className="text-xs text-muted-foreground">/{p.slug}</p>
          </header>
          <AgentMappingSection pipelineId={p.id} />
          {podeEditarConfig && <PipelineEditor pipeline={p} />}
        </Card>
      ))}
    </div>
  );
}

function PipelineEditor({ pipeline }: { pipeline: PipelineRow }) {
  const v = pipeline.vocabulary ?? {};
  const [lead, setLead] = useState(v.lead ?? "Lead");
  const [deal, setDeal] = useState(v.deal ?? "Deal");
  const [won, setWon] = useState(v.won ?? "Ganho");
  const [lost, setLost] = useState(v.lost ?? "Perdido");
  const [reasonsText, setReasonsText] = useState(readLostReasons(pipeline.settings).join(", "));
  const [fieldsJson, setFieldsJson] = useState(
    JSON.stringify(readFields(pipeline.settings), null, 2),
  );
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    let fields: CustomFieldDef[] | undefined;
    try {
      const parsed = JSON.parse(fieldsJson);
      if (!Array.isArray(parsed)) throw new Error("not_array");
      fields = parsed as CustomFieldDef[];
    } catch {
      toast.error("Custom fields: JSON inválido. Esperado um array.");
      return;
    }
    const reasons = reasonsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const patch: PipelineConfigPatch = {
      vocabulary: { lead, deal, won, lost },
      fields: fields as PipelineConfigPatch["fields"],
      lost_reasons: reasons,
    };
    startTransition(async () => {
      const r = await updatePipelineConfig(pipeline.id, patch);
      if (r.ok) toast.success(`${pipeline.name} atualizado.`);
      else toast.error(`Erro: ${r.error}`);
    });
  }

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <h3 className="text-sm font-semibold">Vocabulário e campos</h3>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">Lead</Label>
          <Input value={lead} onChange={(e) => setLead(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Deal</Label>
          <Input value={deal} onChange={(e) => setDeal(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Won</Label>
          <Input value={won} onChange={(e) => setWon(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Lost</Label>
          <Input value={lost} onChange={(e) => setLost(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Motivos de perda (separados por vírgula)</Label>
        <Input value={reasonsText} onChange={(e) => setReasonsText(e.target.value)} />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Custom fields (JSON array)</Label>
        <textarea
          value={fieldsJson}
          onChange={(e) => setFieldsJson(e.target.value)}
          className="min-h-32 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          Ex: <code>{`[{ "key": "size", "label": "Tamanho", "type": "text" }]`}</code>
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? "Salvando…" : "Salvar vocabulário e campos"}
        </Button>
      </div>
    </div>
  );
}
