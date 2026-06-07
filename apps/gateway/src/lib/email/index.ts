import type { EmailProvider } from './provider.js';
import { makeFakeProvider } from './fake-provider.js';
import { makePostmarkProvider } from './postmark-provider.js';

export type { EmailProvider, SendInput, SendResult } from './provider.js';

export interface EmailProviderConfig {
  provider: 'fake' | 'postmark';
  postmarkServerToken: string;
}

export const getEmailProvider = (cfg: EmailProviderConfig): EmailProvider => {
  if (cfg.provider === 'postmark') {
    return makePostmarkProvider({ serverToken: cfg.postmarkServerToken });
  }
  return makeFakeProvider();
};
