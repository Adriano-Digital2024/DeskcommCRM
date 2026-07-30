import { z } from "zod";

export const createChannelSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  provider: z.enum(["waha", "meta_cloud"]).optional().default("waha"),
  // Meta Cloud API credentials (required when provider = meta_cloud)
  meta_phone_number_id: z.string().trim().min(1).optional(),
  meta_waba_id: z.string().trim().min(1).optional(),
  meta_access_token: z.string().trim().min(1).optional(),
});

export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const CHANNEL_STATUSES = [
  "STARTING",
  "SCAN_QR_CODE",
  "WORKING",
  "STOPPED",
  "FAILED",
  "DISCONNECTED",
] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export function isChannelStatus(v: string): v is ChannelStatus {
  return (CHANNEL_STATUSES as readonly string[]).includes(v);
}

export const CHANNEL_COLUMNS =
  "id, provider, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at, meta_phone_number_id, meta_waba_id";
