-- Meta Cloud API provider alongside WAHA
--
-- Adiciona suporte ao Meta Cloud API como provider alternativo ao WAHA.
-- Cada channel_session agora tem um `provider` (waha | meta_cloud) que
-- determina qual adapter de envio usar. Colunas específicas do WAHA foram
-- tornadas opcionais; colunas Meta foram adicionadas.
--
-- Idempotente: todas as operações usam IF NOT EXISTS / IF EXISTS.

-- 1. Nova coluna provider (default 'waha' pra não quebrar linhas existentes)
alter table public.channel_sessions
  add column if not exists provider text not null default 'waha';

-- 2. Meta-specific columns
alter table public.channel_sessions
  add column if not exists meta_phone_number_id text;

alter table public.channel_sessions
  add column if not exists meta_waba_id text;

alter table public.channel_sessions
  add column if not exists meta_access_token_encrypted bytea;

-- 3. WAHA-specific columns tornadas opcionais (Meta não usa)
alter table public.channel_sessions
  alter column waha_session_name drop not null;

alter table public.channel_sessions
  alter column webhook_secret_encrypted drop not null;

-- 4. engine check: adiciona META_CLOUD, permite null
alter table public.channel_sessions
  drop constraint if exists channel_sessions_engine_check;

alter table public.channel_sessions
  add constraint channel_sessions_engine_check
  check (engine is null or engine = any (array['NOWEB'::text, 'WEBJS'::text, 'META_CLOUD'::text]));

-- 5. provider check constraint
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text]));

-- 6. status check: adiciona DISCONNECTED
alter table public.channel_sessions
  drop constraint if exists channel_sessions_status_check;

alter table public.channel_sessions
  add constraint channel_sessions_status_check
  check (status = any (array['STARTING'::text, 'SCAN_QR_CODE'::text, 'WORKING'::text, 'STOPPED'::text, 'FAILED'::text, 'DISCONNECTED'::text]));

-- 7. Índice para queries por provider
create index if not exists idx_channel_sessions_provider
  on public.channel_sessions (organization_id, provider);

-- 8. Função auxiliar: busca channel_session por meta_phone_number_id
create or replace function public.fn_channel_session_by_meta_phone(
  p_phone_number_id text
)
returns table (
  id uuid,
  organization_id uuid,
  provider text,
  status text,
  meta_waba_id text,
  meta_phone_number_id text
)
language sql
stable
security invoker
set search_path = 'public'
as $$
  select
    s.id,
    s.organization_id,
    s.provider,
    s.status,
    s.meta_waba_id,
    s.meta_phone_number_id
  from public.channel_sessions s
  where s.meta_phone_number_id = p_phone_number_id
    and s.provider = 'meta_cloud'
  limit 1;
$$;

-- 9. Atualiza provider check em webhook_events_log para aceitar meta_cloud
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check
  check (provider = any (array['waha'::text, 'nuvemshop'::text, 'generic'::text, 'meta_cloud'::text]));

-- 10. View unificada de canais (abstrai provider)
create or replace view public.vw_channel_sessions as
select
  s.id,
  s.organization_id,
  s.provider,
  s.engine,
  s.status,
  s.status_reason,
  s.phone_number,
  s.display_name,
  s.daily_message_limit,
  s.is_warmup_complete,
  s.last_health_check_at,
  s.last_status_change_at,
  s.consecutive_health_fails,
  s.created_at,
  s.updated_at,
  s.created_by,
  -- WAHA fields (null se provider = meta_cloud)
  case when s.provider = 'waha' then s.waha_session_name else null end as waha_session_name,
  case when s.provider = 'waha' then s.webhook_path_token else null end as webhook_path_token,
  -- Meta fields (null se provider = waha)
  case when s.provider = 'meta_cloud' then s.meta_phone_number_id else null end as meta_phone_number_id,
  case when s.provider = 'meta_cloud' then s.meta_waba_id else null end as meta_waba_id
from public.channel_sessions s;

-- 10. Grant da view
grant select on public.vw_channel_sessions to authenticated, anon, service_role;

-- 11. Atualiza waha_session_name unique constraint para permitir nulls
-- (Postgres permite múltiplos nulls em unique constraint)
-- Precisamos dropar a constraint (que criou um índice com o mesmo nome)
-- antes de criar o índice condicional que permite múltiplos NULLs.
alter table public.channel_sessions
  drop constraint if exists channel_sessions_waha_session_name_unique;
create unique index if not exists channel_sessions_waha_session_name_unique
  on public.channel_sessions (waha_session_name)
  where waha_session_name is not null;

-- 12. Função para criptografar token de acesso Meta
create or replace function public.fn_encrypt_meta_token(
  p_plaintext text,
  p_encryption_key text
)
returns bytea
language plpgsql
security definer
as $$
begin
  return extensions.pgp_sym_encrypt(p_plaintext, p_encryption_key);
end;
$$;

revoke execute on function public.fn_encrypt_meta_token(text, text) from anon, authenticated;

-- 13. Função para descriptografar token de acesso Meta
create or replace function public.fn_decrypt_meta_token(
  p_ciphertext bytea,
  p_encryption_key text
)
returns text
language plpgsql
security definer
as $$
begin
  return extensions.pgp_sym_decrypt(p_ciphertext, p_encryption_key);
exception
  when others then
    return null;
end;
$$;

revoke execute on function public.fn_decrypt_meta_token(bytea, text) from anon, authenticated;
