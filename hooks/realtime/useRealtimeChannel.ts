"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type RealtimeStatus =
  | "connecting"
  | "subscribed"
  | "channel_error"
  | "timed_out"
  | "closed";

export interface UseRealtimeChannelOpts {
  name: string;
  postgresChanges?: {
    event: "INSERT" | "UPDATE" | "DELETE" | "*";
    schema?: string;
    table: string;
    filter?: string;
  };
  broadcast?: { event: string };
  onChange: (payload: unknown) => void;
  enabled?: boolean;
}

/**
 * Autentica o socket do Realtime com o token da sessão (uma vez por client).
 *
 * `setAuth` é do SOCKET, não do canal: vale para todos os canais criados
 * depois. A promise fica memoizada para N hooks não dispararem N requisições.
 *
 * ⚠️ A MEMO SÓ SOBREVIVE AO SUCESSO. Esta é a linha que faltava, e o defeito que
 * ela conserta foi medido em produção-de-desenvolvimento: uma assinatura de
 * `crm_leads` ANÔNIMA (claims.sub nulo) no mesmo socket em que `conversations`
 * estava autenticada. Com RLS por `auth.uid()`, anônimo devolve ZERO linhas: o
 * canal responde SUBSCRIBED e nunca entrega nada — morte silenciosa, a pior
 * forma, porque a tela parece viva.
 *
 * A versão anterior tinha TRÊS saídas e só UMA limpava a memo:
 *   catch { realtimeAuth = null }  → exceção se curava sozinha
 *   if (!res.ok) return            → 401/500: memo FICAVA, setAuth nunca corria
 *   if (token) setAuth(token)      → corpo sem token: memo FICAVA, idem
 *
 * Ou seja: UM ÚNICO 401 transitório — sessão ainda estabelecendo, cookie em
 * renovação — deixava TODOS os canais criados depois anônimos pelo resto
 * daquele carregamento. E a recuperação estava escrita justamente para o
 * caminho BARULHENTO, que era o que menos precisava dela.
 *
 * A REGRA GERAL, que vale para qualquer memoização: o critério não é "deu
 * erro?" — é **o resultado memoizado é o resultado DESEJADO?**. Sucesso parcial
 * memoizado é pior que erro memoizado, porque erro alguém repete.
 */
const AUTH_TIMEOUT_MS = 1_500;

let realtimeAuth: Promise<void> | null = null;

/** Só para teste: zera a memo entre casos (ela é módulo-global de propósito). */
export function __resetRealtimeAuth(): void {
  realtimeAuth = null;
}

export function authenticateRealtime(supabase: ReturnType<typeof createClient>): Promise<void> {
  realtimeAuth ??= (async () => {
    // `autenticou` é o ÚNICO critério de guardar a memo. Não "não deu exceção",
    // não "a resposta chegou": chamou `setAuth` ou não chamou.
    let autenticou = false;
    try {
      const res = await fetch("/api/v1/auth/realtime-token", { credentials: "include" });
      if (res.ok) {
        const body = (await res.json()) as { data?: { access_token?: string } };
        const token = body.data?.access_token;
        if (token) {
          supabase.realtime.setAuth(token);
          autenticou = true;
        }
      }
    } catch {
      // engolido de propósito: ver a degradação abaixo
    }
    if (!autenticou) {
      // Sem token o canal segue anônimo e a UI continua funcionando por refetch,
      // só perde o tempo real — derrubar a tela por causa disso seria pior.
      // MAS A DEGRADAÇÃO VALE SÓ ATÉ A PRÓXIMA TENTATIVA, e é esta linha que faz
      // a próxima tentativa existir. Sem ela, "temporário" virava permanente
      // pelo resto do carregamento.
      realtimeAuth = null;
    }
  })();
  return realtimeAuth;
}

/**
 * Espera o token, mas com teto: assinar 1,5s depois é aceitável; NÃO assinar
 * porque a rota está lenta (ou não existe, como no jsdom dos testes) deixaria a
 * tela sem realtime para sempre. Prazo estourado = canal anônimo, que é o
 * comportamento de antes desta correção, não uma regressão nova.
 */
function esperarAuth(supabase: ReturnType<typeof createClient>): Promise<void> {
  return Promise.race([
    authenticateRealtime(supabase),
    new Promise<void>((resolve) => setTimeout(resolve, AUTH_TIMEOUT_MS)),
  ]);
}

export function useRealtimeChannel(opts: UseRealtimeChannelOpts): { status: RealtimeStatus } {
  const { name, postgresChanges, broadcast, onChange, enabled = true } = opts;

  // ref makes onChange identity-stable so changing handler doesn't re-subscribe
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "closed");

  // React 19 strict mode mounts effects twice in dev. If two consumers ever
  // share the same logical channel name (or the same component re-mounts),
  // Supabase reuses the existing channel object — calling `.on()` after the
  // prior `.subscribe()` errors out. Append a stable per-instance suffix so
  // every hook call owns its own channel topology.
  const instanceId = useId();

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    const supabase = createClient();
    const channelName = `${name}::${instanceId}`;

    // `chain` nunca é null durante o setup; `active` (anulável) existe só pro
    // cleanup — separado para o narrowing do TS não depender de reatribuição.
    let chain: RealtimeChannel = supabase.channel(channelName);

    const handler = (payload: unknown) => {
      onChangeRef.current(payload);
    };

    if (postgresChanges) {
      chain = chain.on(
        "postgres_changes",
        {
          event: postgresChanges.event,
          schema: postgresChanges.schema ?? "public",
          table: postgresChanges.table,
          ...(postgresChanges.filter ? { filter: postgresChanges.filter } : {}),
        },
        handler,
      );
    }

    if (broadcast) {
      chain = chain.on("broadcast", { event: broadcast.event }, handler);
    }

    let active: RealtimeChannel | null = chain;
    let cancelado = false;
    setStatus("connecting");

    // O token tem de chegar ANTES do subscribe: assinar primeiro e autenticar
    // depois deixa o canal anônimo para sempre — ele responde "Subscribed to
    // PostgreSQL" e nunca entrega evento, porque a RLS filtra do outro lado.
    void esperarAuth(supabase).then(() => {
      if (cancelado || !active) return;
      active.subscribe((s) => {
        // s is one of "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED"
        const map: Record<string, RealtimeStatus> = {
          SUBSCRIBED: "subscribed",
          CHANNEL_ERROR: "channel_error",
          TIMED_OUT: "timed_out",
          CLOSED: "closed",
        };
        setStatus(map[s] ?? "connecting");
      });
    });

    return () => {
      cancelado = true;
      if (active) {
        supabase.removeChannel(active);
        active = null;
      }
    };
    // intentionally omit onChange (ref); only re-subscribe when channel topology changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, enabled, instanceId, postgresChanges?.event, postgresChanges?.table, postgresChanges?.filter, postgresChanges?.schema, broadcast?.event]);

  return { status };
}
