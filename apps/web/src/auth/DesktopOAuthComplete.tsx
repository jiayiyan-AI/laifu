import { useSearchParams } from 'react-router-dom';

/**
 * 桌面「系统浏览器走 OAuth」的落地页——纯前端桥接，不做鉴权检查。
 *
 * gateway 的 OAuth 回调（`?client=desktop` 分支）302 到这里，带一个一次性交接码
 * （`code`，60s 有效、用后即焚，见 gateway `auth/desktop-handoff.ts`）+ `channel`
 * 参数（`dev`/`canary`/`stable`，桌面发起登录时随 URL 带上，gateway 原样透传，见
 * `oauth-router.ts`）。gateway 完全不知道桌面 app 注册的 URL scheme——scheme 是
 * 客户端常量，这里是唯一持有它的地方；`channel` → scheme 的映射须与桌面侧
 * `apps/desktop/src-tauri/src/channel.rs` 的 `deep_link_scheme()` 保持一致
 * （三渠道各自独立 scheme，才能在同一台机器上分别安装、分别注册 deep link，
 * 见 `apps/desktop/src-tauri/tauri.conf*.json` 的 `plugins.deep-link`）。
 *
 * 这个页面本身不落 session cookie（gateway 桌面分支跳过了 `Set-Cookie`），只负责把
 * `code` 转手给对应渠道的 `<scheme>://auth-callback`；真正的换 token 发生在桌面 app
 * 的 Rust 侧（`complete_desktop_oauth`）。
 *
 * ⚠️ 不能用 `useEffect` 自动 `location.href = deepLink`：跳转到自定义 URL scheme
 * 属于"启动外部程序"，Chrome（及主流浏览器）要求这个动作必须由一次真实的用户点击
 * 直接触发（transient user activation）；`useEffect` 里异步执行的跳转不带这个标记，
 * 会被浏览器静默丢弃——不报错、不弹确认框，页面停在原地（踩过这个坑）。所以这里的
 * 按钮是唯一路径，不是"自动跳转失败后的兜底"。
 */
const SCHEME_BY_CHANNEL: Record<string, string> = {
  dev: 'laifu-dev',
  canary: 'laifu-canary',
  stable: 'laifu',
};

export const DesktopOAuthComplete = () => {
  const [params] = useSearchParams();
  const code = params.get('code');
  const scheme = SCHEME_BY_CHANNEL[params.get('channel') ?? ''] ?? SCHEME_BY_CHANNEL['stable'];
  const deepLink = code ? `${scheme}://auth-callback?code=${encodeURIComponent(code)}` : null;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      {deepLink ? (
        <>
          <p className="dim">登录成功，点击下方按钮返回来福桌面客户端</p>
          <a href={deepLink} className="btn" autoFocus>返回来福</a>
        </>
      ) : (
        <p style={{ color: '#dc2626' }}>缺少登录凭证，请回到桌面客户端重新登录。</p>
      )}
    </div>
  );
};
