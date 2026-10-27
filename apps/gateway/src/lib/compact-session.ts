/**
 * compact-session.ts — `/compact` 指令: 手动压缩某 thread 在容器里的 agent 会话上下文。
 *
 * web / 微信 / 飞书三渠道共用: 调容器 POST /session/compact 同步等结果, 渲染成给用户的回复文案。
 * 容器侧压缩与对话轮次共用 session 锁, 有正在跑的轮次时会排在其后。
 *
 * 等待上限 COMPACT_TIMEOUT_MS 卡在 ACA ingress (240s) 与 App Service 前端 (230s) 之下;
 * 超时只代表网关不等了, 容器仍会跑完并落盘, 下一轮自动用压缩后的上下文。
 */
import { compactHermesSession } from './aca-call.js';

export const COMPACT_TIMEOUT_MS = 200_000;

export const COMPACT_STARTED_TEXT = '正在压缩会话上下文，大会话可能需要几分钟，完成后会告诉你。';

export interface CompactThreadInput {
  userId: string;
  threadId: string;
  source: string;
  containerUrl: string;
}

/** 约数显示 token: 123456 → "12.3万"。 */
const formatTokens = (n: number): string => (n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n));

/** 执行压缩并返回给用户的回复文案。不抛错。 */
export const compactThreadSession = async (input: CompactThreadInput): Promise<string> => {
  const result = await compactHermesSession({
    ...input,
    sessionId: `${input.source}:${input.threadId}`,
    timeoutMs: COMPACT_TIMEOUT_MS,
  });

  if (!result.ok) {
    if (result.timedOut) return '压缩耗时较长，仍在后台继续；完成后新消息会自动使用压缩后的上下文。';
    // 旧镜像没有 /session/compact 路由
    if (result.status === 404) return '当前助理版本暂不支持手动压缩。';
    return '压缩失败，请稍后再试。';
  }

  switch (result.status) {
    case 'compacted': {
      const after = result.tokensAfter != null ? ` → 约 ${formatTokens(result.tokensAfter)}` : '';
      return `✓ 已压缩会话上下文：约 ${formatTokens(result.tokensBefore)}${after} tokens。早期对话已整理成摘要，最近的内容原样保留。`;
    }
    case 'nothing':
      return '当前会话无需压缩（上下文还不大，或刚压缩过）。';
    case 'no_session':
      return '当前会话还没有可压缩的内容。';
    case 'unsupported':
      return '当前助理运行时不支持手动压缩。';
  }
};
