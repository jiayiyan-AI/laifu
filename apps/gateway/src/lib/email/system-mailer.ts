/**
 * 系统邮件(非 agent 邮箱): 目前只有找回密码。复用 EmailProvider 投递, 纯文本。
 * logLinks 由 EMAIL_PROVIDER=fake 决定(按 env 值切, 不按 NODE_ENV): dev 不真发信, 把链接打日志便于冒烟。
 */
import type { EmailProvider } from './provider.js';

export interface SystemMailer {
  sendPasswordReset(to: string, token: string): Promise<void>;
}

export const resetLinkBase = (cfg: { frontendBaseUrl: string; publicBaseUrl: string }): string =>
  (cfg.frontendBaseUrl || cfg.publicBaseUrl).replace(/\/+$/, '');

export const makeSystemMailer = (deps: {
  provider: EmailProvider;
  domain: string;
  linkBase: string;
  logLinks: boolean;
}): SystemMailer => ({
  async sendPasswordReset(to, token) {
    const link = `${deps.linkBase}/reset-password?token=${encodeURIComponent(token)}`;
    if (deps.logLinks) console.log(`[system-mailer] 重置链接 to=${to}: ${link}`);
    await deps.provider.send({
      from_addr: `noreply@${deps.domain}`,
      from_name: '灵犀',
      to: [to],
      cc: [],
      subject: '重置你的灵犀密码',
      body_text: [
        '你好，',
        '',
        '我们收到了重置你灵犀账号密码的请求。点击下面的链接设置新密码：',
        '',
        link,
        '',
        '该链接 30 分钟内有效，且只能使用一次。',
        '如果不是你本人操作，请忽略这封邮件，你的密码不会改变。',
        '',
        '— 灵犀',
      ].join('\n'),
    });
  },
});
