import type { ParsedInboundEmail } from '@lingxi/shared';

/** 发信入参 (gateway 已算好 from / 线程头, provider 只管投递) */
export interface SendInput {
  from_addr: string;        // '<localpart>@<domain>'
  from_name: string;        // 显示名
  to: string[];
  cc: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string;     // 原邮件 Message-ID (线程头)
  reference_ids?: string[]; // References 链
}

export interface SendResult {
  message_id: string;       // 投递后的 Message-ID (落 outbound 行用)
}

/**
 * 邮件服务商适配器。fake (dev) / resend (prod) 各实现一份, 业务码只依赖此接口。
 */
export interface EmailProvider {
  /**
   * 把入站 webhook 的 request body 解析成中立结构。
   * 解析不出有效收件人时抛错 (路由会回 400)。
   */
  parseInbound(body: unknown): ParsedInboundEmail;
  /** 实际投递, 返回 Message-ID。 */
  send(input: SendInput): Promise<SendResult>;
}
