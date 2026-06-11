import type { EmailProvider } from './provider.js';
import { makeFakeProvider } from './fake-provider.js';
import { makePostmarkProvider } from './postmark-provider.js';
import { makeResendProvider } from './resend-provider.js';

export type { EmailProvider, SendInput, SendResult } from './provider.js';

export interface EmailProviderConfig {
  provider: 'fake' | 'postmark' | 'resend';
  postmarkServerToken: string;
  resendApiKey: string;
  /** 出站 Message-ID 合成用域名 (resend) */
  domain: string;
}

export const getEmailProvider = (cfg: EmailProviderConfig): EmailProvider => {
  if (cfg.provider === 'postmark') {
    return makePostmarkProvider({ serverToken: cfg.postmarkServerToken });
  }
  if (cfg.provider === 'resend') {
    return makeResendProvider({ apiKey: cfg.resendApiKey, domain: cfg.domain });
  }
  return makeFakeProvider();
};
