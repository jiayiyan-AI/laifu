import type { EmailProvider } from './provider.js';
import { makeFakeProvider } from './fake-provider.js';
import { makeResendProvider } from './resend-provider.js';

export type { EmailProvider, SendInput, SendResult } from './provider.js';

export interface EmailProviderConfig {
  provider: 'fake' | 'resend';
  resendApiKey: string;
  /** 出站 Message-ID 合成用域名 (resend) */
  domain: string;
}

export const getEmailProvider = (cfg: EmailProviderConfig): EmailProvider => {
  if (cfg.provider === 'resend') {
    return makeResendProvider({ apiKey: cfg.resendApiKey, domain: cfg.domain });
  }
  return makeFakeProvider();
};
