/**
 * slash-filter.ts — 拦截用户消息里的 Hermes `/xxx` 指令。
 *
 * ## 背景
 * 我们用 `hermes chat -Q --yolo -q "<msg>"` 调用 Hermes。在 `-Q -q` 这条
 * single-query + quiet 路径上,Hermes 端**完全不会**把消息当 slash 处理 —
 * `cli.py:13864` 直接 `agent.run_conversation(user_message=...)`,绕过了
 * `process_command()` 的 dispatcher。所以 `/new` `/reset` 等不会真改 Hermes
 * 状态。但 LLM 仍会把字面文本当成"命令请求"演戏,污染 state.db 历史 +
 * 浪费一轮调用。
 *
 * ## 策略(三档)
 * 1. **拦截**(intercept):整个网关层就给出确定的回复,不喂给 Hermes。
 *    - **拒绝类**:`/new` `/reset` `/clear` 等改 session 元状态的,跟 web UI
 *      "新对话/删除会话/列表切换" 直接冲突 → 静态文案引导用户用 UI。
 *    - **配置类**:`/model` `/yolo` `/personality` 等被后端统一锁定的开关 →
 *      告知不支持。
 *    - **网关自答**:`/help` `/version` `/usage` `/status` → 网关直接渲染
 *      (查 DB / 读静态值),不调 LLM。
 * 2. **透传**(forward):未识别的 `/<word>`(skill 触发 / 长尾)原样喂给
 *    Hermes,让 LLM 自然处理(实测大概率回复"无法执行"而非演戏)。
 *
 * ## 边界(详见下方 SLASH_RE)
 * - 只识别"斜杠 + 字母开头单词"的形式 → 不会误判 /etc/hosts、//comment、
 *   /123、/foo/bar 这类 path / 注释 / 数字开头(它们都走 forward 原样透传)。
 * - 多行消息只看首段:斜杠命令换行后接其他文字仍按命令处理。
 * - 命令名大小写不敏感:/Help 等价 /help。
 *
 * ## 接口
 * - `classifyMessage(raw)` → `SlashAction`(纯函数,不查 DB)
 * - `runIntercept(action, ctx)` → `Promise<string>`(网关回复正文,可能查 DB)
 *
 * 调用方在 `chat.ts` 里:命中 intercept 就走"立即完成 loop"流程把 reply
 * 当 assistant 消息落库;命中 forward 就继续原有 dispatchHermesChat 链路。
 */

import { dao } from '../db/index.js';

// ─── 公共类型 ─────────────────────────────────────────────────────────

export interface SlashCtx {
  userId: string;
  threadId: string;
  args: string;
}

export type SlashAction =
  | {
      kind: 'intercept';
      cmd: string;          // 规范化后的小写命令名,日志/审计用
      args: string;         // 命令参数(strip 后的剩余文本)
      logTag: string;       // 大类标签:reject_session / reject_config / gateway_help / ...
      render: SlashRenderer;
    }
  | { kind: 'forward' };

export type SlashRenderer = (ctx: SlashCtx) => string | Promise<string>;

// ─── 命令注册表 ───────────────────────────────────────────────────────

interface RegistryEntry {
  render: SlashRenderer;
  logTag: string;
}

const Static = (msg: string): SlashRenderer => () => msg;

// session 元操作 — 跟 web UI 直接冲突,引导用户用界面
const REJECT_SESSION = {
  'new':      '请点击页面"新对话"按钮新建会话。灵犀的会话由系统自动管理,无法在聊天框里手动新建。',
  'reset':    '请点击页面"新对话"按钮新建会话。',
  'clear':    '请点击页面"新对话"按钮新建会话。',
  'undo':     '灵犀暂不支持撤回上一轮对话,如需重新提问请直接重发。',
  'retry':    '灵犀暂不支持 /retry,请直接重发您的问题。',
  'branch':   '灵犀暂不支持会话分支(/branch)。',
  'fork':     '灵犀暂不支持会话分支(/fork)。',
  'title':    '会话标题由系统根据首条消息自动生成,暂不支持手动设置。',
  'resume':   '请在页面左侧的会话列表中切换历史会话。',
  'sessions': '请在页面左侧的会话列表查看历史会话。',
  'switch':   '请在页面左侧的会话列表中切换会话。',
  'quit':     '关闭浏览器标签即可结束当前会话。',
  'exit':     '关闭浏览器标签即可结束当前会话。',
  'handoff':  '灵犀暂不支持跨平台会话移交(/handoff)。',
  'save':     '灵犀的对话内容自动保存,无需手动 /save。',
  'history':  '请在页面查看完整的对话历史。',
  'redraw':   '该指令仅用于命令行界面,在灵犀里无意义。',
  'paste':    '请直接将图片拖入或粘贴到聊天框。',
  'copy':     '请直接选中文本复制。',
  'image':    '请直接通过聊天框附件按钮上传图片。',
} as const;

// 配置类 — 后端统一管理,用户无法切换
const REJECT_CONFIG = {
  'model':         '当前模型由后端统一配置,暂不支持用户切换。',
  'personality':   '灵犀暂不支持自定义人格(/personality)。',
  'yolo':          '执行模式由后端固定,无需用户切换。',
  'fast':          '执行模式由后端统一配置。',
  'reasoning':     '推理强度由后端统一配置。',
  'skin':          '主题样式不在灵犀客户端支持范围内。',
  'voice':         '语音功能尚未开通。',
  'verbose':       '工具进度展示由后端配置,无法切换。',
  'statusbar':     '该选项不在灵犀客户端支持范围内。',
  'busy':          '该选项仅适用于命令行界面。',
  'indicator':     '该选项仅适用于命令行界面。',
  'footer':        '该选项仅适用于命令行界面。',
  'codex-runtime': '运行时由后端统一配置。',
  'compress':      '会话上下文压缩由后端自动管理,无需手动触发。',
  'snapshot':      '灵犀暂不支持配置快照(/snapshot)。',
  'snap':          '灵犀暂不支持配置快照(/snap)。',
  'rollback':      '灵犀暂不支持文件回滚(/rollback)。',
  'config':        '配置由后端统一管理,聊天框内不可见。',
  'profile':       '账户与配置项请在页面"个人中心"查看。',
} as const;

// 工具/技能类 — 我们的客户端不暴露这些 surface
const REJECT_TOOLS = {
  'tools':         '工具集由后端统一配置,无法在聊天框切换。',
  'toolsets':      '工具集由后端统一配置。',
  'skills':        '技能管理请使用网页"能力开关"页面。',
  'reload':        '配置由后端管理,无需手动 /reload。',
  'reload-mcp':    '配置由后端管理,无需手动 /reload-mcp。',
  'reload_mcp':    '配置由后端管理。',
  'reload-skills': '配置由后端管理。',
  'reload_skills': '配置由后端管理。',
  'plugins':       '插件由后端统一配置。',
  'browser':       '浏览器工具由后端统一配置。',
  'cron':          '灵犀暂不开放定时任务功能(/cron)。',
  'curator':       '后台技能维护由系统自动运行。',
  'memory':        '记忆管理请使用网页对应入口。',
  'kanban':        '灵犀暂不开放看板功能(/kanban)。',
  'goal':          '灵犀暂不开放持续目标功能(/goal)。',
  'subgoal':       '灵犀暂不开放子目标功能。',
  'queue':         '请直接发送您的下一条消息,系统会自动排队。',
  'q':             '请直接发送您的下一条消息,系统会自动排队。',
  'steer':         '请直接发送您的引导消息。',
  'background':    '灵犀暂不开放后台会话(/background)。',
  'bg':            '灵犀暂不开放后台会话(/bg)。',
  'btw':           '灵犀暂不开放后台会话(/btw)。',
  'agents':        '灵犀暂不开放多 agent 视图。',
  'tasks':         '灵犀暂不开放任务视图。',
  'platforms':     '请使用网页"账户中心"查看绑定平台。',
  'gateway':       '请使用网页"账户中心"查看绑定平台。',
  'platform':      '平台管理由后端统一配置。',
  'sethome':       '该指令仅用于消息平台的家会话设定。',
  'set-home':      '该指令仅用于消息平台的家会话设定。',
  'topic':         '该指令仅用于 Telegram 多会话模式。',
  'approve':       '危险命令审批由后端 yolo 模式处理。',
  'deny':          '危险命令审批由后端 yolo 模式处理。',
  'commands':      '请使用 /help 查看可用命令。',
  'debug':         '调试报告功能由开发团队内部使用。',
  'gquota':        '配额查询请使用 /usage。',
  'insights':      '使用统计请使用 /usage 查询。',
  'bundles':       '技能包由后端统一配置。',
  'stop':          '后台进程由后端管理,聊天框内无 /stop 指令。',
  'update':        '版本升级由后端统一管理。',
  'restart':       '服务重启由后端统一管理。',
  'whoami':        '请在网页右上角账户菜单查看账户信息。',
} as const;

// ─── 网关自答档 — 静态信息 ───────────────────────────────────────────

const HELP_TEXT = [
  '【灵犀可用指令】',
  '  /help     显示本帮助',
  '  /version  查看灵犀版本',
  '  /usage    查看本月用量与余额',
  '  /status   查看当前会话与容器状态',
  '',
  '【操作提示】',
  '  · 新建/切换/删除会话: 请使用页面左侧"新对话"按钮和会话列表',
  '  · 上传图片或附件: 点击聊天框附件按钮,或直接拖入',
  '  · 模型、记忆、工具集等由后端统一配置,无需手动切换',
].join('\n');

const VERSION_TEXT = `灵犀版本: ${process.env['LINGXI_VERSION'] ?? 'dev'}`;
const renderUsage: SlashRenderer = async (ctx) => {
  try {
    const b = await dao.usage.getBalance(ctx.userId);
    const used = b.used_cny_month.toFixed(2);
    const free = b.free_quota_cny_month.toFixed(2);
    const balance = b.balance_cny.toFixed(2);
    const remainingFree = Math.max(0, b.free_quota_cny_month - b.used_cny_month).toFixed(2);
    return [
      '【本月用量(单位: 元)】',
      `  已用: ¥${used}`,
      `  免费额度: ¥${free} (剩余 ¥${remainingFree})`,
      `  账户余额: ¥${balance}`,
      `  计费周期起: ${b.period_start}`,
    ].join('\n');
  } catch {
    return '用量查询暂不可用,请稍后再试。';
  }
};

const renderStatus: SlashRenderer = async (ctx) => {
  const mapping = dao.cache.get(ctx.userId);
  const lines = [`会话: ${ctx.threadId}`];
  if (!mapping) {
    lines.push('容器: 未开通');
  } else {
    lines.push(`容器: ${mapping.status}`);
    if (mapping.status !== 'ready') {
      if (mapping.provisioning_step) lines.push(`进度: ${mapping.provisioning_step} (${mapping.progress_pct}%)`);
      if (mapping.error_message) lines.push(`错误: ${mapping.error_message}`);
    }
  }
  return lines.join('\n');
};

// ─── 注册表组装 ───────────────────────────────────────────────────────

const REGISTRY: Record<string, RegistryEntry> = {};

const registerOrThrow = (cmd: string, entry: RegistryEntry): void => {
  if (REGISTRY[cmd]) {
    throw new Error(`slash-filter: duplicate cmd "${cmd}" (existing tag=${REGISTRY[cmd].logTag}, new tag=${entry.logTag})`);
  }
  REGISTRY[cmd] = entry;
};

for (const [cmd, msg] of Object.entries(REJECT_SESSION)) {
  registerOrThrow(cmd, { render: Static(msg), logTag: 'reject_session' });
}
for (const [cmd, msg] of Object.entries(REJECT_CONFIG)) {
  registerOrThrow(cmd, { render: Static(msg), logTag: 'reject_config' });
}
for (const [cmd, msg] of Object.entries(REJECT_TOOLS)) {
  registerOrThrow(cmd, { render: Static(msg), logTag: 'reject_tools' });
}
registerOrThrow('help',    { render: Static(HELP_TEXT),    logTag: 'gateway_help' });
registerOrThrow('version', { render: Static(VERSION_TEXT), logTag: 'gateway_version' });
registerOrThrow('usage',   { render: renderUsage,          logTag: 'gateway_usage' });
registerOrThrow('status',  { render: renderStatus,         logTag: 'gateway_status' });
registerOrThrow('start',   { render: Static('欢迎使用灵犀。请直接发送消息开始对话。'), logTag: 'gateway_start' });

// ─── 分类入口 ─────────────────────────────────────────────────────────

/**
 * 严格识别 slash 命令。要求:
 *   - 首个非空白字符是 `/`
 *   - 紧接着是字母开头的 `[A-Za-z][\w-]*`(允许中划线和下划线)
 *   - 命令名后要么直接结束,要么紧跟空白 + 任意参数
 *
 * 不匹配:
 *   `/etc/hosts`(命令名后是 `/`,不是空白)
 *   `//comment` `/123foo` `/-flag`(首字符不是字母)
 *   纯 `/`(无命令名)
 */
const SLASH_RE = /^\s*\/([A-Za-z][\w-]*)(?:\s+([\s\S]*?))?\s*$/;

export const classifyMessage = (raw: string): SlashAction => {
  if (typeof raw !== 'string' || raw.length === 0) return { kind: 'forward' };
  const m = SLASH_RE.exec(raw);
  if (!m) return { kind: 'forward' };
  const cmd = m[1]!.toLowerCase();
  const args = (m[2] ?? '').trim();

  const entry = REGISTRY[cmd];
  if (entry) {
    return { kind: 'intercept', cmd, args, logTag: entry.logTag, render: entry.render };
  }

  // 未识别的 /<word>(skill 类长尾)→ 让 Hermes 自然处理
  return { kind: 'forward' };
};

/**
 * 调用 intercept 档的 render,容错:渲染抛错时返回兜底文案。
 *
 * 调用方传入业务上下文(用户 / 会话 / 命令参数),render 内部按需查 DB。
 */
export const runIntercept = async (
  action: Extract<SlashAction, { kind: 'intercept' }>,
  ctx: Pick<SlashCtx, 'userId' | 'threadId'>,
): Promise<string> => {
  try {
    return await action.render({ ...ctx, args: action.args });
  } catch {
    return '指令处理失败,请稍后再试。';
  }
};
