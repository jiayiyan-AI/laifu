// === Container HTTP 契约 (Gateway → Container) ===
// 沿用同事 Hermes Container (docker/hermes/server/, 前身 server.py) 的同步 /chat 契约

export interface ContainerChatRequest {
  message: string;
  session_id: string;          // e.g. "web:thr_abc123" / "wechat:main"
  source: 'web' | 'wechat' | 'feishu';
  /** 带此字段 → 容器走异步 202 模式；不带 → 保留同步模式（向后兼容 + 测试） */
  callback?: { loop_id: string };
}

/** 容器异步回调 gateway 的 body — discriminated union */
export type HermesCallbackPayload =
  | HermesCallbackHeartbeat
  | HermesCallbackResult;

export interface HermesCallbackHeartbeat {
  type: 'heartbeat';
  loop_id: string;
}

export interface HermesCallbackResult {
  type: 'result';
  loop_id: string;
  reply: string;
  exit_code: number;
  hermes_session_id?: string | null;
  usage?: ContainerChatUsage;
}

export interface ContainerChatUsage {
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}

export interface ContainerChatResponse {
  reply: string;
  session_id: string;
  exit_code: number;
  hermes_session_id?: string | null;
  usage?: ContainerChatUsage;       // server/index.ts (前身 server.py PR1) 稳定返回; ? 兑兼旧镜像
}

export interface ContainerHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;                  // unix epoch (seconds, float)
}

export interface ContainerHistoryResponse {
  messages: ContainerHistoryMessage[];
}

// === Gateway Web API 契约 (Web → Gateway) ===

export interface PurchaseRequest {
  assistant_name: string;        // 用户给助理起的名字（必填，trim 后 1..24 字符）
  email_localpart?: string;      // 用户自填的专属邮箱前缀（可选；留空→后端 u-<hash> 默认）。用户自己输入，不再拼音派生。
}

export interface PurchaseResponse {
  user_id: string;
  status: 'provisioning' | 'ready' | 'failed';
}

/** 购买失败的稳定错误码（前端据此精确提示，不靠英文字符串匹配）。 */
export type PurchaseErrorCode = 'invalid_assistant_name' | 'invalid_localpart' | 'email_taken';

/** 购买接口错误响应体。 */
export interface PurchaseErrorResponse {
  error: string;
  code: PurchaseErrorCode;
}

export interface StatusResponse {
  status: 'provisioning' | 'ready' | 'failed';
  provisioning_step: string | null;
  progress_pct: number;
  error_message: string | null;
  // P1 字段 (Task 11 起必填；status 路由始终返回，默认 []/0)
  entitlements_desired: string[];     // user_entitlements 表里 active 的 feature
  entitlements_observed: string[];    // container_observed_state 里容器最后报告的
  container_token_version: number;    // 当前 users.token_version（前端用来比对 observed）
  assistant_name: string | null;      // container_mapping.assistant_name
  assistant_email: string | null;     // 真实专属邮箱（含碰撞后缀）= localpart@EMAIL_DOMAIN; 未分配则 null
}

// === Auth 契约 ===

export interface AuthMeResponse {
  user_id: string;
  provider: string;          // 'google' | 'dev' | 'github' | ...
  external_id: string;
  email: string | null;
  nickname: string | null;
  avatar_url: string | null;
  email_domain: string;        // 当前部署的助理邮箱域名（前端实时预览拼）；= 后端 EMAIL_DOMAIN
}

/** 账号密码登录请求 */
export interface PasswordLoginRequest {
  email: string;
  password: string;
}

/** 账号密码注册请求 */
export interface PasswordRegisterRequest {
  email: string;
  password: string;
  nickname: string;
}

/** 注册/登录失败的稳定错误码。前端据此给精确提示，不靠英文文案字符串匹配。 */
export type AuthErrorCode =
  | 'invalid_email'
  | 'password_too_short'
  | 'nickname_required'
  | 'email_taken'
  | 'invalid_credentials';

/** 认证类接口的错误响应体（400/401/409 等非 2xx 共用）。 */
export interface AuthErrorResponse {
  error: string;          // 英文调试信息（给开发看）
  code: AuthErrorCode;    // 前端映射文案用
}

/** 密码最小长度（前后端共用，保证客户端即时校验与服务端一致）。 */
export const MIN_PASSWORD_LENGTH = 8;

// === Threads 契约 ===

export interface ThreadCreateRequest {
  title?: string;            // 可选；后端会用首条消息补
}

export interface ThreadCreateResponse {
  id: string;                // e.g. "thr_abc123"
  user_id: string;
  source: 'web';
  title: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface ThreadListItem {
  id: string;
  title: string | null;
  updated_at: string;
  archived: boolean;
}

// === Web chat 契约（浏览器 ↔ Gateway,同步）===

export interface WebChatRequest {
  thread_id: string;
  message: string;
}

/**
 * POST /api/chat 的响应,discriminated union:
 *   - `dispatched`: 消息已转发 Hermes,带 user_msg_id + loop_id,前端订阅 SSE 等结果
 *   - `inline`: 网关已就地处理 (e.g. /help /usage 或 /new 等被拦截的 slash),
 *     直接给一段文案,**不入库**。前端把它显示为临时气泡,刷新即消失。
 */
export type WebChatResponse =
  | { kind: 'dispatched'; user_msg_id: string; loop_id: string }
  | { kind: 'inline'; reply: string };

// 历史消息(浏览器从 gateway 拉);形状跟 ContainerHistoryMessage 一致,
// 单独起名是为了 Web 端可以单方向加字段(比如本地的 pending 标记)
export type ThreadMessage = ContainerHistoryMessage;

// === Messages 表 Web 视图 ===

export interface MessageRow {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content_type: 'text' | 'json';
  content: unknown;
  source: 'web' | 'wechat' | 'feishu';
  created_at: string;
}

export interface AgentLoopRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  completion: 'success' | 'fail' | 'limit' | null;
  created_at: string;
  completed_at: string | null;
}

export interface WebThreadMessagesResponse {
  messages: MessageRow[];
}

// === 微信 iLink 扫码绑定契约 ===

export interface WechatQrStartResponse {
  qrcode: string;             // iLink session_key,后续 qr-poll 透传
  qr_content: string;         // ⚠️ 不是 URL 也不是 base64 — 是要编码进 QR 码的 payload 字符串。
                              //   前端用 QRCodeSVG/QRCodeCanvas 渲染成图。命名跟 iLink 字段
                              //   qrcode_img_content 对齐。
}

export interface WechatQrPollRequest {
  qrcode: string;             // 来自 WechatQrStartResponse.qrcode
}

/**
 * qr-poll 透传 iLink 状态,confirmed 时附 bound=true + ilink_bot_id。
 * - wait/scaned/expired: 前端继续轮询(scaned 表示扫了但没确认,UI 提示 "已扫描请确认")
 * - scaned_but_redirect: iLink 要求换 host (本地不实现重定向,直接报错 UI)
 * - confirmed: 后端已落库 + 起轮询,前端 UI 切到 bound 态
 */
export type WechatQrPollResponse =
  | { status: 'wait' | 'scaned' | 'expired' }
  | { status: 'scaned_but_redirect'; redirect_host: string }
  | { status: 'confirmed'; bound: true; ilink_bot_id: string };

export type WechatBindingInfoResponse =
  | { bound: false }
  | { bound: true; ilink_bot_id: string; bound_at: string };

export interface WechatUnbindResponse {
  ok: true;
}

// === 微信附件 (P1: 图片) ===

/** 微信附件在 hermes 容器内的引用 (临时缓存, 7 天 TTL)。 */
export interface WechatAttachmentRef {
  kind: 'image';                  // P2 扩 'file'|'voice'|'video'
  cache_path: string;             // 容器内绝对路径, e.g. /home/hermes/.hermes/cache/images/img_xxx.jpg
  content_type: string;           // image/jpeg | image/png | ...
  size: number;                   // 解密后字节数
}

// === Cloud Drive 契约 (P0 起步，P1/P2 继续扩展) ===

/**
 * Container（hermes 容器内）拿到的写 SAS 配置。
 * P1 `/api/cloud/sas` 端点返回此 shape。
 *
 * `sas_token` 已经是 directory-scoped (sr=d, sdd=1)，授权范围严格限制在
 * `<container>/<prefix>` 子树。客户端拼 URL 时用：
 *   `${blob_endpoint}/${container}/${prefix}<virtual_path>?${sas_token}`
 */
export interface CloudWriteSasResponse {
  blob_endpoint: string;      // e.g. "https://laifudev.blob.core.windows.net"
  container: string;          // "laifu-cloud"
  prefix: string;             // "<user_id>/", 含尾 /
  sas_token: string;          // 不含前导 '?' 的 query 字符串
  expires_at: string;         // ISO-8601
}

/**
 * Cloud drive 操作允许的权限集合（spec §五）。
 * write SAS 通常给 racwl，read SAS 通常只给 r。
 */
export type CloudSasPermission = 'r' | 'a' | 'c' | 'w' | 'l' | 'd';

// === P1 Entitlement / Token 契约 ===

/**
 * 容器侧拉取自己开通的 features (GET /api/me/entitlements)。
 * 返回的 entitlements 已经过 active 过滤（disabled_at IS NULL）。
 */
export interface EntitlementsList {
  entitlements: string[];   // e.g. ['cloud']
  token_version: number;    // 当前 users.token_version；容器据此决定是否需要续签
}

/**
 * 容器 entrypoint 完成 skill 软链后回报 (POST /api/me/observed-entitlements)。
 * gateway 写到 container_observed_state，让前端等待 modal 能等到容器真生效。
 */
export interface ObservedEntitlementsReport {
  observed: string[];        // 实际软链到 ~/.hermes/skills/ 的 feature 列表
  token_version: number;     // 容器启动时 JWT 里的 token_version；让 gateway 检测版本漂移
}

/**
 * 续签端点 (POST /api/auth/refresh-token)。响应是新 token。
 * 请求体为空，鉴权靠 Authorization: Bearer <旧 token>（含 grace 接受）。
 */
export interface RefreshTokenResponse {
  token: string;             // 新签 JWT (90d exp)
  expires_at: string;        // ISO-8601, exp 字段的人可读形式
}

/**
 * 容器启动时拉运行期配置 (GET /api/me/runtime-config)。
 * 由 docker/hermes/scripts/pull-runtime-config.ts 调用,渲染 ~/.hermes/config.yaml。
 *
 * 设计动机: 之前 provider/model/base_url 是 createContainerApp 时一次性写进 ACA env 的快照,
 * 之后永远锁死。改成每次容器启动 pull 后, gateway 改这几个值 + ACA restart 即生效,
 * 无需 recreate ACA。详见 task.md。
 *
 * 鉴权: Authorization: Bearer <LAIFU_USER_TOKEN> (复用 container-token middleware)。
 */
/**
 * 动态 prompt 文件清单。容器侧拿到后跟 ~/dynamic_prompts/manifest.json 比对,
 * 只下载变化的文件。详见 docs/managed-prompts.md §五 manifest 协商机制。
 *
 * version: 协议版本号。容器侧脚本看到不识别的 version → 跳过同步,
 *          保留本地老文件 (避免不兼容的解析方式破坏 home volume)。
 *          目前 1; 字段语义不兼容变更时 bump。
 * files:   name → sha256[:16]
 *
 * 已知文件名:
 *   - SOUL.md         下载后镜像写到 ~/.hermes/SOUL.md (Hermes 默认读那个位置);
 *                     远端删除时不动 ~/.hermes/SOUL.md (避免破坏 hermes 默认行为)
 *   - system-prompt.md  目前只镜像到 ~/.hermes/system-prompt.md, 是否被 hermes
 *                       注入待进一步验证
 */
export interface PromptsManifest {
  version: number;
  files: Record<string, string>;
}

// GET /api/me/runtime-config 的响应。provider/model/base_url 已迁到 ACA spec env
// (azure.ts buildSpec, 容器直接读环境变量), 此端点只剩 prompts manifest 协商。
export interface RuntimeConfig {
  prompts_manifest: PromptsManifest;
}

/**
 * Entitlement 修改端点的响应 (POST /api/entitlements/{feature}/{enable,disable})。
 * 返回当前 active entitlements。restart 是异步触发的，前端用 /api/status 轮询。
 */
export interface EntitlementChangeResponse {
  ok: true;
  entitlements: string[];
  changed: boolean;           // 是否真发生了状态变更 (active <-> disabled)
}

/**
 * Cloud drive list response (P2 /api/cloud/list).
 * gateway 在此端点统一解码 metadata 的 base64 字段，前端不再解码。
 */
export interface CloudFileItem {
  virtual_path: string;       // relative to <user_id>/
  size: number;
  last_modified: string;      // ISO-8601
  content_type: string | null;
  metadata: {
    title: string;            // decoded UTF-8
    session_id: string | null;
    published_at: string | null;
    tool_version: string | null;
    description: string | null;
    tags: string[] | null;
    source: 'web' | 'agent';  // 文件来源：web 上传 or agent 发布；旧文件缺省 'agent'
  };
}

export interface CloudFolderItem {
  virtual_path: string;       // relative to <user_id>/, with trailing /
}

export interface CloudListResponse {
  folders: CloudFolderItem[];
  files: CloudFileItem[];
}

/**
 * Web 上传响应 (POST /api/cloud/upload)。
 * gateway 代理写 Blob 成功后返回。
 */
export interface CloudUploadResponse {
  ok: true;
  virtual_path: string;       // relative to <user_id>/
  size: number;               // bytes written
  last_modified: string;      // ISO-8601
}

// === 邮件能力 (B1) ===

/** 一个入站附件在 Blob 里的引用 + 元数据。key 是 email-attachments 容器内相对路径,不含 userId。 */
export interface AttachmentRef {
  key: string;          // e.g. "01JAB...-quote.pdf"
  filename: string;     // 原始文件名(展示 + 下载 content-disposition)
  content_type: string; // MIME, 缺省 "application/octet-stream"
  size: number;         // 字节
}

/** provider 把入站邮件解析成的中立结构 */
export interface ParsedInboundEmail {
  to_localpart: string;        // 收件人 @ 前那段, 路由键
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  message_id: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  body_text: string;           // 去引用后的纯文本
  has_attachments: boolean;
  attachment_keys: AttachmentRef[];  // 无附件则 []
}

export type EmailDirection = 'inbound' | 'outbound';

/** 列表项 (不含正文, 列表轻量) */
export interface EmailListItem {
  id: string;
  direction: EmailDirection;
  from_addr: string;
  to_addrs: string[];
  subject: string;
  has_attachments: boolean;
  received_at: string;
}

export interface EmailListResponse {
  emails: EmailListItem[];
}

/** 单封详情 (含正文 + 线程头) */
export interface EmailDetail extends EmailListItem {
  cc_addrs: string[];
  message_id: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  body_text: string;
  attachment_keys: AttachmentRef[];
}

export interface EmailDetailResponse {
  email: EmailDetail;
}

/** 容器 CLI 发信请求 */
export interface EmailSendRequest {
  to: string[];
  cc?: string[];
  subject: string;
  body_text: string;
  in_reply_to_id?: string;     // 给定则按该邮件接线程 + 收件人默认=原发件人
}

export interface EmailSendResponse {
  ok: true;
  id: string;                  // 落库的 outbound 邮件 id
  message_id: string;          // provider 返回的 Message-ID
}

/**
 * 可经 /api/entitlements/:feature/(enable|disable) 管理的能力 id —— 单一来源。
 * 网关 ALLOWED_FEATURES 由此派生; web catalog 的 removable 能力 id 必须与此集合一致
 * (apps/web/src/lib/capabilities.test.ts 有防漂移断言)。
 * 新增可装备能力时只改这里 + web catalog。
 */
export const MANAGEABLE_FEATURES = ['cloud', 'email'] as const;
export type ManageableFeature = (typeof MANAGEABLE_FEATURES)[number];
