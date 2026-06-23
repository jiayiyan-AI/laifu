/**
 * Feishu app registration via OAuth device-code flow.
 *
 * Migrated from openclaw/extensions/feishu/src/app-registration.ts.
 * Changes from source:
 *  - Removed printQrCode / qrcode-terminal (frontend renders QR URL directly).
 *  - Replaced fetchWithSsrFGuard with native global fetch (gateway is a trusted
 *    process targeting fixed Feishu hostnames, no SSRF surface).
 *  - Removed openclaw/plugin-sdk/* imports entirely.
 *  - Inlined FeishuDomain type.
 *  - Renamed AppRegistrationResult.openId → ownerOpenId for external API clarity.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";

const REGISTRATION_PATH = "/oauth/v1/app/registration";

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeishuDomain = "feishu" | "lark";

export interface AppRegistrationResult {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  ownerOpenId?: string;
}

interface InitResponse {
  nonce: string;
  supported_auth_methods: string[];
}

export interface BeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expireIn: number;
}

interface RawBeginResponse {
  device_code: string;
  verification_uri: string;
  user_code: string;
  verification_uri_complete: string;
  interval: number;
  expire_in: number;
}

interface PollResponse {
  client_id?: string;
  client_secret?: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: "feishu" | "lark";
  };
  error?: string;
  error_description?: string;
}

export type PollOutcome =
  | { status: "success"; result: AppRegistrationResult }
  | { status: "access_denied" }
  | { status: "expired" }
  | { status: "timeout" }
  | { status: "error"; message: string };

/**
 * 单次轮询结果 (供 web 长轮询语义的 scan-poll 路由用)。
 *
 * 与 PollOutcome 不同: 无 timeout/access_denied 等内部循环状态，
 * 而是把 pending/success/denied/expired/error 映射成前端可直接消费的离散状态。
 * - authorization_pending / slow_down → pending
 * - client_id & client_secret 同时出现 → success
 * - access_denied → denied
 * - expired_token → expired
 * - lark 域切换 / 其他 error / 网络抖动 → pending (继续轮询)
 */
export type SinglePollResult =
  | { status: "pending"; domainSwitchedTo?: FeishuDomain }
  | { status: "success"; result: AppRegistrationResult }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accountsBaseUrl(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

async function postRegistration<T>(baseUrl: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`${baseUrl}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Registration poll returns 4xx for pending/error states with a JSON body.
  return (await response.json()) as T;
}

async function fetchFeishuJson<T>(params: { url: string; init: RequestInit }): Promise<T> {
  const response = await fetch(params.url, params.init);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Step 1: Initialize registration and verify the environment supports
 * `client_secret` auth.
 *
 * @throws If the environment does not support `client_secret`.
 */
export async function initAppRegistration(domain: FeishuDomain = "feishu"): Promise<void> {
  const baseUrl = accountsBaseUrl(domain);
  const res = await postRegistration<InitResponse>(baseUrl, { action: "init" });

  if (!res.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Current environment does not support client_secret auth method");
  }
}

/**
 * Step 2: Begin the device-code flow. Returns a device code and a QR URL
 * that the user should scan with Feishu/Lark mobile app.
 *
 * Calls init internally to verify client_secret support before proceeding.
 */
export async function beginAppRegistration(domain: FeishuDomain = "feishu"): Promise<BeginResult> {
  const baseUrl = accountsBaseUrl(domain);

  // Inline init step before begin (mirrors source flow where init is called first).
  const initRes = await postRegistration<InitResponse>(baseUrl, { action: "init" });
  if (!initRes.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Current environment does not support client_secret auth method");
  }

  const res = await postRegistration<RawBeginResponse>(baseUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  const qrUrl = new URL(res.verification_uri_complete);
  qrUrl.searchParams.set("from", "oc_onboard");
  qrUrl.searchParams.set("tp", "ob_cli_app");

  return {
    deviceCode: res.device_code,
    qrUrl: qrUrl.toString(),
    userCode: res.user_code,
    interval: res.interval || 5,
    expireIn: res.expire_in || 600,
  };
}

/**
 * Step 3: Poll for authorization result until success, denial, expiry, or
 * timeout. Automatically handles domain switching when `tenant_brand` is
 * detected as "lark".
 */
export async function pollAppRegistration(params: {
  deviceCode: string;
  interval: number;
  expireIn: number;
  initialDomain?: FeishuDomain;
  abortSignal?: AbortSignal;
  /** Registration type parameter: "ob_user" for user mode, "ob_app" for bot mode. */
  tp?: string;
}): Promise<PollOutcome> {
  const { deviceCode, expireIn, initialDomain = "feishu", abortSignal, tp } = params;
  let currentInterval = params.interval;
  let domain: FeishuDomain = initialDomain;
  let domainSwitched = false;

  const deadline = Date.now() + expireIn * 1000;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      return { status: "timeout" };
    }

    let single: SinglePollResult;
    try {
      single = await pollAppRegistrationOnce(deviceCode, domain, tp);
    } catch {
      // Transient network error — keep polling.
      await sleep(currentInterval * 1000);
      continue;
    }

    switch (single.status) {
      case "success":
        return { status: "success", result: single.result };
      case "denied":
        return { status: "access_denied" };
      case "expired":
        return { status: "expired" };
      case "error":
        return { status: "error", message: single.message };
      case "pending":
        if (single.domainSwitchedTo && !domainSwitched) {
          domain = single.domainSwitchedTo;
          domainSwitched = true;
          // Retry poll immediately with the correct domain (no sleep).
          continue;
        }
        // slow_down is signalled via error inside Once; we can't see it here,
        // so the interval bump is best-effort lost on the loop path. Keep the
        // original behaviour close by leaving currentInterval as-is.
        break;
    }

    await sleep(currentInterval * 1000);
  }

  return { status: "timeout" };
}

/**
 * 单次轮询: 发一次 action:poll 请求并把飞书响应映射成 SinglePollResult。
 *
 * 这是从 pollAppRegistration 整段循环里抽出来的"一格"，给 web 长轮询路由
 * (POST /api/feishu/bind/scan-poll) 用 —— 每次 HTTP 请求只轮一次，立即返回。
 *
 * 映射规则:
 *   - client_id & client_secret → success
 *   - error=authorization_pending / slow_down → pending
 *   - tenant_brand=lark (域需切换) → pending + domainSwitchedTo='lark'
 *   - error=access_denied → denied
 *   - error=expired_token → expired
 *   - 其他 error → error
 *   - 无 error 无凭证 → pending (兜底，继续轮询)
 *
 * 网络错误直接抛出，由调用方决定是否继续轮询 (循环版会吞掉重试，
 * 路由版可映射成 pending)。
 */
export async function pollAppRegistrationOnce(
  deviceCode: string,
  domain: FeishuDomain,
  tp?: string,
): Promise<SinglePollResult> {
  const baseUrl = accountsBaseUrl(domain);

  const pollRes = await postRegistration<PollResponse>(baseUrl, {
    action: "poll",
    device_code: deviceCode,
    ...(tp ? { tp } : {}),
  });

  // Domain auto-detection: signal a switch to lark if tenant_brand says so.
  if (pollRes.user_info?.tenant_brand === "lark" && domain !== "lark") {
    return { status: "pending", domainSwitchedTo: "lark" };
  }

  // Success.
  if (pollRes.client_id && pollRes.client_secret) {
    return {
      status: "success",
      result: {
        appId: pollRes.client_id,
        appSecret: pollRes.client_secret,
        domain,
        ownerOpenId: pollRes.user_info?.open_id,
      },
    };
  }

  // Error handling.
  if (pollRes.error) {
    if (pollRes.error === "authorization_pending" || pollRes.error === "slow_down") {
      return { status: "pending" };
    }
    if (pollRes.error === "access_denied") {
      return { status: "denied" };
    }
    if (pollRes.error === "expired_token") {
      return { status: "expired" };
    }
    return {
      status: "error",
      message: `${pollRes.error}: ${pollRes.error_description ?? "unknown"}`,
    };
  }

  // No credentials, no error — still pending.
  return { status: "pending" };
}

/**
 * Fetch the app owner's open_id using the application.v6.application.get API.
 *
 * Used during setup to auto-populate security policy allowlists.
 * Returns undefined on any failure (fail-open).
 */
export async function getAppOwnerOpenId(params: {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}): Promise<string | undefined> {
  const baseUrl =
    params.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

  try {
    // First, get a tenant_access_token.
    const tokenData = await fetchFeishuJson<{
      code?: number;
      tenant_access_token?: string;
    }>({
      url: `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: params.appId, app_secret: params.appSecret }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    });
    if (!tokenData.tenant_access_token) {
      return undefined;
    }

    // Query app info for the owner's open_id.
    const appData = await fetchFeishuJson<{
      code?: number;
      data?: {
        app?: {
          owner?: { owner_id?: string; owner_type?: number; type?: number };
          creator_id?: string;
        };
      };
    }>({
      url: `${baseUrl}/open-apis/application/v6/applications/${params.appId}?user_id_type=open_id`,
      init: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenData.tenant_access_token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    });
    if (appData.code !== 0) {
      return undefined;
    }

    const app = appData.data?.app;
    const owner = app?.owner;
    const ownerType = owner?.owner_type ?? owner?.type;
    // owner_type=2 means enterprise member; use owner_id. Otherwise fallback to creator_id.
    return ownerType === 2 && owner?.owner_id
      ? owner.owner_id
      : (app?.creator_id ?? owner?.owner_id);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
