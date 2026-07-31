-- 0088_ai_providers_openrouter_agentrouter
--
-- Abre o vocabulário de providers de LLM para OpenRouter e AgentRouter, que o
-- runtime do agent-engine já suporta (lib/agent-engine/edge/llm/providers.ts +
-- env OPENROUTER_*/AGENTROUTER_*). A UI/API de credenciais (BYOK) e de agents
-- já aceitam os dois novos valores; sem este relaxamento o INSERT caía no CHECK
-- e a tela /app/ai/credentials devolvia 500 pra qualquer credencial desses
-- providers.
--
-- Idempotente: drop-if-exists + add (mesmo padrão do apêndice do baseline.sql
-- pra channel_sessions_status_check). Apenas AFROUXA valores permitidos — nenhuma
-- linha existente pode violar o CHECK novo, então re-aplicar é seguro (update.sh
-- de clones).
--
-- Tabelas tocadas:
--   ai_provider_credentials.provider
--   ai_agent_versions.provider
--   ai_models.provider (catálogo curado — self-hoster passa a poder cadastrar
--                       modelos próprios dos providers novos)

alter table public.ai_provider_credentials
  drop constraint if exists ai_provider_credentials_provider_check;
alter table public.ai_provider_credentials
  add constraint ai_provider_credentials_provider_check
  check (provider = any (array['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text, 'agentrouter'::text]));

alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_provider_check;
alter table public.ai_agent_versions
  add constraint ai_agent_versions_provider_check
  check (provider = any (array['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text, 'agentrouter'::text]));

alter table public.ai_models
  drop constraint if exists ai_models_provider_check;
alter table public.ai_models
  add constraint ai_models_provider_check
  check (provider = any (array['anthropic'::text, 'openai'::text, 'google'::text, 'openrouter'::text, 'agentrouter'::text]));
