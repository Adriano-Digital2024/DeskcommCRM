-- 0090_lgpd_requests_pending_review
--
-- lgpd-redact-worker e lgpd-export-worker marcam requests como
-- 'pending_review' (L-03 no local footprint, no_delivery_email,
-- email_not_configured), mas o CHECK original de lgpd_requests.status não
-- listava esse valor → o UPDATE caía em 23514 e, como o worker não capturava o
-- erro, o request ficava PRESO em 'processing' para sempre (invisível na fila
-- de revisão). O TypeScript já emitia 'pending_review' (lib/lgpd/types.ts).
--
-- Só ADICIONA um valor permitido (afrouxa) — nenhuma linha existente pode
-- violar o CHECK novo, então re-aplicar é seguro (update.sh de clones).
-- `alter table if exists` cobre a cadeia de migrations (a tabela nasce no
-- baseline do kit; a cadeia 00001..0089 não a cria).

alter table if exists public.lgpd_requests
  drop constraint if exists lgpd_requests_status_check;
alter table if exists public.lgpd_requests
  add constraint lgpd_requests_status_check
  check (status = any (array['received'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'expired'::text, 'pending_review'::text]));
