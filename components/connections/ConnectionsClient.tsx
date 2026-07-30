"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  useChannelSessions,
  type ChannelSession,
} from "@/hooks/channels/useChannelSessions";
import { usePacingKnobs } from "@/hooks/channels/usePacingKnobs";
import { AntiBanSheet } from "./AntiBanSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowRight,
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Phone,
  Plus,
  ShieldCheck,
  Warning,
} from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";

type Variant = "success" | "warning" | "error" | "neutral";

const STATUS_MAP: Record<string, { label: string; variant: Variant }> = {
  WORKING: { label: "Conectado", variant: "success" },
  SCAN_QR_CODE: { label: "Escaneie o QR", variant: "warning" },
  STARTING: { label: "Conectando…", variant: "warning" },
  STOPPED: { label: "Parado", variant: "error" },
  FAILED: { label: "Caiu", variant: "error" },
};

function statusInfo(status: string): { label: string; variant: Variant } {
  return STATUS_MAP[status] ?? { label: status, variant: "neutral" };
}

function channelLabel(c: ChannelSession): string {
  return c.display_name || c.phone_number || c.meta_phone_number_id || c.waha_session_name || "WhatsApp";
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function isMetaSession(c: ChannelSession): boolean {
  return c.provider === "meta_cloud";
}

function hasWahaSession(c: ChannelSession): boolean {
  return c.provider === "waha" && !!c.waha_session_name;
}

export function ConnectionsClient({ wahaConfigured }: { wahaConfigured: boolean }) {
  const qc = useQueryClient();
  const { data: sessions, isLoading } = useChannelSessions({ refetchInterval: 10_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [qr, setQr] = useState<{ sessionId: string; title: string } | null>(null);
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);
  const [metaTokenDialog, setMetaTokenDialog] = useState<{
    sessionId: string;
    label: string;
    reason: string;
  } | null>(null);
  const [antiBanId, setAntiBanId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const pacingItems = usePacingKnobs().data?.items ?? [];

  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["channel-sessions"] }),
    [qc],
  );

  const hasAnyWaha = (sessions ?? []).some(hasWahaSession);
  const hasAnyMeta = (sessions ?? []).some(isMetaSession);
  const healthCheckEnabled = hasAnyWaha ? wahaConfigured : sessions && sessions.length > 0;

  const runHealthCheck = useCallback(
    async (list: ChannelSession[]) => {
      if (list.length === 0) return;
      setChecking(true);
      try {
        await Promise.allSettled(
          list.map((c) => apiClient.get(`/api/v1/channel-sessions/${c.id}`)),
        );
        invalidate();
      } finally {
        setChecking(false);
      }
    },
    [invalidate],
  );

  const didInitialCheck = useRef(false);
  useEffect(() => {
    if (didInitialCheck.current || !sessions || sessions.length === 0) return;
    didInitialCheck.current = true;
    void runHealthCheck(sessions);
  }, [sessions, runHealthCheck]);

  const handleConnectNew = useCallback(async () => {
    if (!wahaConfigured) {
      toast.error("O serviço WAHA não está ativo. Suba o container para conectar novos números.");
      return;
    }
    setCreating(true);
    try {
      const res = await apiClient.post<{ data: ChannelSession }>(
        "/api/v1/channel-sessions",
        {},
      );
      invalidate();
      setQr({ sessionId: res.data.id, title: "Conectar novo WhatsApp" });
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível iniciar a conexão."));
    } finally {
      setCreating(false);
    }
  }, [invalidate, wahaConfigured]);

  const handleReconnect = useCallback(
    async (c: ChannelSession, newToken?: string) => {
      setBusyId(c.id);
      setSuccessMsg(null);
      setMetaTokenDialog(null);
      try {
        const body = newToken ? { meta_access_token: newToken } : {};
        const res = await apiClient.post<{ data: { status: string; provider?: string; reason?: string } }>(
          `/api/v1/channel-sessions/${c.id}/reconnect`,
          body,
        );
        invalidate();

        if (res.data.provider === "meta_cloud") {
          if (res.data.status === "WORKING") {
            toast.success(`${channelLabel(c)} reconectado com sucesso!`);
          } else {
            setMetaTokenDialog({
              sessionId: c.id,
              label: channelLabel(c),
              reason: res.data.reason ?? "Token de acesso Meta inválido ou expirado.",
            });
          }
        } else {
          setQr({ sessionId: c.id, title: `Reconectar ${channelLabel(c)}` });
        }
      } catch (err) {
        toast.error(errMsg(err, "Não foi possível reconectar."));
      } finally {
        setBusyId(null);
      }
    },
    [invalidate],
  );

  const handleConnected = useCallback(() => {
    toast.success("WhatsApp conectado!");
    setQr(null);
    invalidate();
  }, [invalidate]);

  const list = sessions ?? [];

  const showWahaWarning = hasAnyWaha && !wahaConfigured;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {list.length === 0
            ? "Nenhum número conectado ainda."
            : `${list.length} ${list.length === 1 ? "número conectado" : "números conectados"}.`}
        </p>
        <div className="flex gap-2">
          {list.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={checking || (hasAnyWaha && !wahaConfigured)}
              onClick={() => void runHealthCheck(list)}
            >
              <ArrowsClockwise
                size={14}
                className={checking ? "animate-spin" : undefined}
                aria-hidden
              />
              Atualizar saúde
            </Button>
          )}
          <Button
            size="sm"
            disabled={creating || !wahaConfigured}
            onClick={handleConnectNew}
          >
            {creating ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <Plus size={14} aria-hidden />
            )}
            Conectar novo WhatsApp
          </Button>
        </div>
      </div>

      {showWahaWarning && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">O serviço do WhatsApp (WAHA) não está ativo.</p>
          <p className="mt-1">
            Suba o container (<code>docker compose up -d waha</code>) para conectar e reconectar números WhatsApp via WAHA.
          </p>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando conexões…</p>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Phone size={28} className="text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Conecte seu primeiro número de WhatsApp para começar a atender.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => {
            const info = statusInfo(c.status);
            const isMeta = isMetaSession(c);
            const canReconnect = isMeta || wahaConfigured;
            return (
              <Card key={c.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Phone size={16} className="text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium">{channelLabel(c)}</span>
                      {isMeta && (
                        <span className="text-[10px] text-muted-foreground">Meta Cloud</span>
                      )}
                    </div>
                    {c.phone_number && c.display_name && (
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {c.phone_number}
                      </p>
                    )}
                  </div>
                  <Badge variant={info.variant}>{info.label}</Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {c.last_health_check_at
                    ? `Verificado ${new Date(c.last_health_check_at).toLocaleString("pt-BR")}`
                    : "Ainda não verificado"}
                  {c.status_reason && (
                    <span className="ml-2 text-error-fg">— {c.status_reason}</span>
                  )}
                </p>
                <div className="mt-auto flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === c.id || !canReconnect}
                    onClick={() => handleReconnect(c)}
                  >
                    {busyId === c.id ? (
                      <CircleNotch size={14} className="animate-spin" aria-hidden />
                    ) : (
                      <ArrowsClockwise size={14} aria-hidden />
                    )}
                    Reconectar
                  </Button>
                  {isMeta ? (
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href="https://developers.facebook.com/apps/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Warning size={14} aria-hidden />
                        Token expirado?
                      </a>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setAntiBanId(c.id)}>
                      <ShieldCheck size={14} aria-hidden />
                      Proteção de envio
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {successMsg && (
        <Dialog open onOpenChange={() => setSuccessMsg(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Conexão verificada</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-2 py-4 text-sm">
              <CheckCircle size={28} weight="fill" className="text-success-fg" aria-hidden />
              <p>{successMsg}</p>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {errorDialog && (
        <Dialog open onOpenChange={() => setErrorDialog(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{errorDialog.title}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-2 py-4 text-sm text-error-fg">
              <Warning size={28} aria-hidden />
              <p className="text-center">{errorDialog.message}</p>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {metaTokenDialog && (
        <MetaTokenDialog
          sessionId={metaTokenDialog.sessionId}
          label={metaTokenDialog.label}
          reason={metaTokenDialog.reason}
          busy={busyId === metaTokenDialog.sessionId}
          onReconnect={handleReconnect}
          onClose={() => setMetaTokenDialog(null)}
        />
      )}

      <AntiBanSheet
        item={pacingItems.find((i) => i.channel_session.id === antiBanId) ?? null}
        canWrite
        onClose={() => setAntiBanId(null)}
      />

      {qr && (
        <QrDialog
          sessionId={qr.sessionId}
          title={qr.title}
          wahaConfigured={wahaConfigured}
          onClose={() => setQr(null)}
          onConnected={handleConnected}
        />
      )}
    </div>
  );
}

function QrDialog({
  sessionId,
  title,
  wahaConfigured,
  onClose,
  onConnected,
}: {
  sessionId: string;
  title: string;
  wahaConfigured: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [status, setStatus] = useState<string>("STARTING");
  const [tick, setTick] = useState(0);
  const done = useRef(false);
  const qrShown = useRef(false);

  useEffect(() => {
    if (!wahaConfigured) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiClient.get<{ data: { status: string } }>(
          `/api/v1/channel-sessions/${sessionId}`,
        );
        if (cancelled) return;
        const s = res.data.status;
        setStatus(s);
        if (s === "SCAN_QR_CODE" && !qrShown.current) {
          qrShown.current = true;
          setTick((t) => t + 1);
        }
        if (s === "WORKING" && !done.current) {
          done.current = true;
          onConnected();
        }
      } catch {
        // erro transitório de rede — o próximo tick tenta de novo
      }
    };
    void poll();
    const iv = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sessionId, wahaConfigured, onConnected]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o código.
          </DialogDescription>
        </DialogHeader>
            <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 py-2">
          {status === "SCAN_QR_CODE" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={tick}
              src={`/api/v1/channel-sessions/${sessionId}/qr?t=${tick}`}
              alt="QR Code para conectar WhatsApp"
              className="h-64 w-64 rounded-md border bg-white p-2"
            />
          ) : status === "WORKING" ? (
            <div className="flex flex-col items-center gap-2 text-sm font-medium text-success-fg">
              <CheckCircle size={28} weight="fill" aria-hidden />
              Conectado!
            </div>
          ) : status === "FAILED" || status === "STOPPED" ? (
            <p className="text-center text-sm text-error-fg">
              Não foi possível conectar. Feche e tente "Reconectar".
            </p>
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <CircleNotch size={28} className="animate-spin" aria-hidden />
              Preparando o código…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MetaTokenDialog({
  sessionId,
  label,
  reason,
  busy,
  onReconnect,
  onClose,
}: {
  sessionId: string;
  label: string;
  reason: string;
  busy: boolean;
  onReconnect: (c: ChannelSession, newToken: string) => Promise<void>;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");

  const handleSubmit = () => {
    if (!token.trim()) return;
    void onReconnect({ id: sessionId, provider: "meta_cloud" } as ChannelSession, token.trim());
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{label} — Token expirado</DialogTitle>
          <DialogDescription>
            {reason}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="rounded-md bg-warning-bg p-3 text-sm text-warning-fg">
            <p className="font-medium">Como gerar um novo token:</p>
            <ol className="ml-4 mt-2 list-decimal space-y-1">
              <li>Acesse o <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer" className="underline">Meta Developer Portal</a></li>
              <li>Vá em WhatsApp → Configurações da API</li>
              <li>Clique em "Gerar Token" e copie o token</li>
              <li>Cole o token no campo abaixo</li>
            </ol>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="meta-token" className="text-sm font-medium">
              Novo token de acesso
            </label>
            <Input
              id="meta-token"
              placeholder="Cole o token aqui..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={busy || !token.trim()}>
              {busy ? <CircleNotch size={14} className="animate-spin" aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              Reconectar com novo token
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
