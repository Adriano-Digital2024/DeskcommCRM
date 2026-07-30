import { env } from "@/lib/env";

const META_GRAPH_BASE = "https://graph.facebook.com/v22.0";

export interface MetaSendTextResult {
  message_id: string;
}

export interface MetaSendTemplateResult {
  message_id: string;
}

export interface MetaTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  parameters?: Record<string, unknown>[];
}

export interface MetaTemplateMessage {
  name: string;
  language: { code: string };
  components?: MetaTemplateComponent[];
}

export interface MetaMediaUploadResult {
  id: string;
}

export interface MetaWebhookPayload {
  object: "whatsapp_business_account";
  entry: {
    id: string;
    changes: {
      field: "messages";
      value: {
        messaging_product: "whatsapp";
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: {
          profile: { name: string };
          wa_id: string;
        }[];
        messages?: {
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
          image?: { id: string; mime_type: string };
          video?: { id: string; mime_type: string };
          audio?: { id: string; mime_type: string };
          document?: { id: string; mime_type: string; filename?: string };
          sticker?: { id: string; mime_type: string };
          location?: { latitude: number; longitude: number };
          button?: { payload: string; text: string };
          interactive?: { button_reply?: { id: string; title: string }; nfm_reply?: unknown };
        }[];
        statuses?: {
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
          conversation?: { id: string };
          pricing?: { model: string; category: string };
        }[];
      };
    }[];
  }[];
}

export class MetaCloudClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {}

  private get apiBase(): string {
    return `${META_GRAPH_BASE}/${this.phoneNumberId}`;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: URLSearchParams | FormData } = {},
  ): Promise<T> {
    const url = `${this.apiBase}/${path}`;
    const method = options.method ?? "POST";

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };

    if (options.body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: options.body,
    });

    const body = await res.text();

    if (!res.ok) {
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { error?: { message: string; code: number } };
        if (parsed.error) {
          detail = `meta_error_${parsed.error.code}: ${parsed.error.message}`;
        }
      } catch {}
      throw new Error(detail);
    }

    return JSON.parse(body) as T;
  }

  async sendText(to: string, text: string, previewUrl: boolean = false): Promise<MetaSendTextResult> {
    const body = new URLSearchParams({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      [`text`]: JSON.stringify({ preview_url: previewUrl, body: text }),
    });
    return this.request<MetaSendTextResult>("messages", { body });
  }

  async sendTemplate(
    to: string,
    template: MetaTemplateMessage,
  ): Promise<MetaSendTemplateResult> {
    const body = new URLSearchParams({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: JSON.stringify(template),
    });
    return this.request<MetaSendTemplateResult>("messages", { body });
  }

  async sendMedia(
    to: string,
    mediaId: string,
    type: string,
    caption?: string,
  ): Promise<MetaSendTextResult> {
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: type === "sticker" ? "sticker" : type === "document" ? "document" : type,
    };
    const mediaKey = type === "image" ? "image" : type === "video" ? "video" : type === "audio" ? "audio" : "document";
    const mediaObj: Record<string, unknown> = { id: mediaId };
    if (caption) mediaObj.caption = caption;
    payload[mediaKey] = mediaObj;

    const body = new URLSearchParams();
    for (const [key, val] of Object.entries(payload)) {
      body.set(key, typeof val === "object" ? JSON.stringify(val) : String(val));
    }

    return this.request<MetaSendTextResult>("messages", { body });
  }

  async uploadMedia(fileUrl: string, mimeType: string): Promise<MetaMediaUploadResult> {
    const body = new URLSearchParams({
      messaging_product: "whatsapp",
      type: mimeType,
      source_url: fileUrl,
    });
    return this.request<MetaMediaUploadResult>("media", { body });
  }

  async getMedia(mediaId: string): Promise<{ url: string; mime_type: string }> {
    const url = `${META_GRAPH_BASE}/${mediaId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`meta_get_media_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<{ url: string; mime_type: string }>;
  }

  async downloadMedia(mediaId: string): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    const meta = await this.getMedia(mediaId);
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) throw new Error(`meta_download_${res.status}`);
    return { buffer: await res.arrayBuffer(), mimeType: meta.mime_type };
  }

  async verifyToken(): Promise<boolean> {
    try {
      const res = await fetch(
        `${META_GRAPH_BASE}/${this.phoneNumberId}?fields=id,display_phone_number,quality_rating`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async markMessageAsRead(messageId: string): Promise<void> {
    const body = new URLSearchParams({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
    await this.request<void>("messages", { body });
  }
}

export function metaFriendlyError(msg: string): string {
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|timeout|EAI_AGAIN/i.test(msg)) {
    return "Não foi possível conectar à API do WhatsApp (Meta Cloud). Verifique sua conexão.";
  }
  if (/meta_error_(100|190)|access_token|expired|invalid|Authentication required/i.test(msg)) {
    return "Token de acesso Meta inválido ou expirado. Gere um novo token no Meta Developer Portal e atualize a integração.";
  }
  return `Falha na comunicação com a Meta Cloud API: ${msg}`;
}
