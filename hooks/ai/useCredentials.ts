"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "agentrouter";

export interface CredentialRow {
  id: string;
  organization_id: string;
  provider: Provider;
  label: string;
  api_key_last4: string | null;
  validated_at: string | null;
  validation_error: string | null;
  models_available: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  data: CredentialRow[];
}

export const credentialsListQueryKey = ["ai", "credentials", "list"] as const;

export function useCredentialsList(opts?: { initialData?: CredentialRow[] }) {
  return useQuery({
    queryKey: credentialsListQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<ListResponse>("/api/v1/ai/credentials");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

export function credentialStatus(row: CredentialRow): "validated" | "validating" | "invalid" | "inactive" {
  if (!row.is_active) return "inactive";
  if (row.validation_error) return "invalid";
  if (row.validated_at) return "validated";
  return "validating";
}
