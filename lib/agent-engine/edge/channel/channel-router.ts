import type pg from 'pg';

import type { ChannelAdapter, ChannelCapabilities, ChannelCost, ChannelSendInput, ChannelSendResult, ChannelSessionHealth } from '../../channel-adapter';
import type { CrmEdgeConfig } from '../crm/mcp-client';
import { WahaChannelAdapter } from './waha-adapter';
import { MetaChannelAdapter } from './meta-adapter';

export class ChannelAdapterRouter implements ChannelAdapter {
  readonly channel = 'router';
  private readonly waha: WahaChannelAdapter;
  private readonly meta: MetaChannelAdapter;
  private readonly db: pg.Pool;

  constructor(db: pg.Pool, crmCfg: CrmEdgeConfig) {
    this.db = db;
    this.waha = new WahaChannelAdapter(db, crmCfg);
    this.meta = new MetaChannelAdapter(db, crmCfg);
  }

  private async adapterForConversation(conversationId: string): Promise<ChannelAdapter> {
    const { rows } = await this.db.query<{ provider: string }>(
      `select cs.provider
       from conversations c
       join channel_sessions cs on cs.id = c.channel_session_id
       where c.id = $1`,
      [conversationId],
    );
    return rows[0]?.provider === 'meta_cloud' ? this.meta : this.waha;
  }

  private async adapterForSession(channelSessionId: string): Promise<ChannelAdapter> {
    const { rows } = await this.db.query<{ provider: string }>(
      `select provider from channel_sessions where id = $1`,
      [channelSessionId],
    );
    return rows[0]?.provider === 'meta_cloud' ? this.meta : this.waha;
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    const adapter = await this.adapterForConversation(input.conversationId);
    return adapter.send(input);
  }

  async sessionHealth(channelSessionId: string): Promise<ChannelSessionHealth> {
    const adapter = await this.adapterForSession(channelSessionId);
    return adapter.sessionHealth(channelSessionId);
  }

  capabilities(): ChannelCapabilities {
    return this.waha.capabilities();
  }

  costPerMessage(): ChannelCost {
    return this.waha.costPerMessage();
  }
}
