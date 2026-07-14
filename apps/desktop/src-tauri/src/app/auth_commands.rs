//! 登录相关 Tauri commands：webview 登录、桌面 OAuth 回流、登出、登录态查询。

use std::sync::Arc;

use tauri::{Emitter, Manager, State};

use crate::auth::keychain::{self, StoredCredential};
use crate::state::AuthState;

use super::core::AppCore;
use super::window::{HOME_WINDOW, LOGIN_WINDOW};

/// web 首页 URL。严格按编译期渠道（dev/canary/stable）取值，不接受运行时 env 覆盖：
/// `home` 是能调用 native OAuth command 的远程页面，其 origin 必须与
/// `capabilities/home-remote.json` 中经审计的静态 ACL 白名单一致。首页自带一整套鉴权
/// （web 前端登录页 + httpOnly session cookie），不经过 Rust。同步盘需要设备 JWT 时，
/// 直接从已登录的首页 WebView 读取该 cookie 并交换 token，避免再打开一个登录窗口。
pub(super) fn home_url() -> String {
    crate::channel::home_url_default()
}

/// 登录 webview 指向的 URL。默认按渠道取值；`LINGXI_LOGIN_URL` env 可临时覆盖。
/// 用户在此完成 OAuth/密码登录后，gateway 302 到 `/desktop` 并下发 httpOnly session cookie。
fn login_url() -> String {
    std::env::var("LINGXI_LOGIN_URL").unwrap_or_else(|_| crate::channel::login_url_default())
}

/// session cookie 名，对齐 gateway `config.session.cookieName`（默认 `lingxi_sid`，
/// 三渠道共用同一名字——各渠道走各自的 gateway/前端源，浏览器级已天然隔离）。
fn session_cookie_name() -> String {
    std::env::var("LINGXI_SESSION_COOKIE").unwrap_or_else(|_| "lingxi_sid".to_string())
}

/// 打开登录 webview（文档 §11.4）。
///
/// （wry WKWebView 后端保留 httpOnly 标记）。已登录首页会直接读 cookie 换设备 JWT；
/// 否则建登录 webview，待其真实导航命中 `/desktop` 后读取 cookie 并换 token。全流程
/// 都在 Rust 侧闭环：存 keychain → emit "authed" → 关窗，不依赖远程页面 IPC 回传。
#[tauri::command]
pub(super) async fn open_login(
    app: tauri::AppHandle,
    core: State<'_, Arc<AppCore>>,
) -> Result<(), String> {
    // 已登录则直接回 authed，不重复开窗。
    if core.auth.lock().await.is_authed() {
        let _ = app.emit("authed", ());
        return Ok(());
    }
    // 首页已登录但同步盘尚无设备 JWT：直接复用首页的 httpOnly session cookie。
    // 不能等 login WebView 的 SPA 跳转到 `/desktop`；History API 不会触发 on_navigation，
    // 会使同步盘永久停在“登录中”。
    if let Some(home) = app.get_webview_window(HOME_WINDOW) {
        if let Some(cookie_header) = session_cookie_header(&home, core.inner())? {
            exchange_session_cookie(core.inner(), &cookie_header).await?;
            app.emit("authed", ()).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    // 登录窗已在（用户重复点登录）：聚焦已有窗而非报 "label 已存在"。
    if let Some(win) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = win.set_focus();
        return Ok(());
    }

    // `completed`：token 交换是否成功。on_navigation 换 token 后置 true；
    // 窗关闭时据此区分"成功后自动关" vs "用户中途取消"，避免前端 loggingIn 永久卡住。
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // `fired`：on_navigation 可能对同一 URL 触发多次；保证只 spawn 一次换 token。
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app_nav = app.clone();
    let core_nav = core.inner().clone();
    let completed_nav = completed.clone();

    let win = tauri::WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW,
        tauri::WebviewUrl::External(
            login_url()
                .parse()
                .map_err(|e| format!("bad login url: {e}"))?,
        ),
    )
    .title("登录来福同步盘")
    .inner_size(480.0, 640.0)
    .on_navigation(move |url| {
        // gateway 登录成功 302 到 /desktop；命中即触发换 token。放行导航（返回 true）。
        if url.path().contains("/desktop") && !fired.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let app2 = app_nav.clone();
            let core2 = core_nav.clone();
            let completed2 = completed_nav.clone();
            tauri::async_runtime::spawn(async move {
                match complete_login(&app2, &core2).await {
                    Ok(()) => {
                        completed2.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    Err(e) => {
                        eprintln!("[open_login] complete_login failed: {e}");
                        // 换 token 失败：通知前端解除 loggingIn 并显错，然后关窗。
                        completed2.store(true, std::sync::atomic::Ordering::SeqCst);
                        let _ = app2.emit("login-failed", e);
                        if let Some(w) = app2.get_webview_window(LOGIN_WINDOW) {
                            let _ = w.close();
                        }
                    }
                }
            });
        }
        true
    })
    .build()
    .map_err(|e| e.to_string())?;

    // 窗关闭时若未完成 token 交换 → 用户主动取消：emit 让前端复位 loggingIn。
    let app_evt = app.clone();
    win.on_window_event(move |ev| {
        if let tauri::WindowEvent::Destroyed = ev {
            if !completed.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = app_evt.emit("login-cancelled", ());
            }
        }
    });

    Ok(())
}

/// 登录 webview 命中 `/desktop` 后：读 native cookie → 换 device JWT → 存 keychain →
/// emit "authed" → 关登录窗。
async fn complete_login(app: &tauri::AppHandle, core: &Arc<AppCore>) -> Result<(), String> {
    let win = app
        .get_webview_window(LOGIN_WINDOW)
        .ok_or_else(|| "login window gone".to_string())?;
    let cookie_header = session_cookie_header(&win, core)?.ok_or_else(|| {
        format!(
            "session cookie `{}` not found after login",
            session_cookie_name()
        )
    })?;

    exchange_session_cookie(core, &cookie_header).await?;
    let _ = win.close();
    app.emit("authed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从指定 WebView 读取 gateway session cookie，并格式化为 device-token 所需的 Cookie header。
fn session_cookie_header(
    win: &tauri::WebviewWindow,
    core: &AppCore,
) -> Result<Option<String>, String> {
    // session cookie 由 gateway（base_url）以其 host 落盘；按 gateway URL 取。
    let gw_url: tauri::Url = core
        .gateway
        .base_url()
        .parse()
        .map_err(|e| format!("bad gateway url: {e}"))?;
    let name = session_cookie_name();

    Ok(win
        .cookies_for_url(gw_url)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|c| c.name() == name)
        .map(|c| format!("{}={}", c.name(), c.value())))
}

/// 用已认证 WebView 中的 session cookie 换取并持久化同步盘设备 JWT。
async fn exchange_session_cookie(core: &AppCore, cookie_header: &str) -> Result<(), String> {
    let tok = core
        .gateway
        .device_token(cookie_header)
        .await
        .map_err(|e| e.to_string())?;
    keychain::store(&StoredCredential {
        jwt: tok.token.clone(),
        expires_at: tok.expires_at.clone(),
    })
    .map_err(|e| e.to_string())?;
    *core.auth.lock().await = AuthState::authed_from(tok);
    Ok(())
}

/// 桌面 deep link 回调 `laifu://auth-callback?code=...` 命中后：用一次性交接码换设备
/// JWT（第一跳，见 gateway `auth/desktop-handoff.ts`）→ 存 keychain → 再用刚拿到的
/// JWT 换第二个一次性码，导航 `home` 窗口的 WebView 到 gateway `session-from-code`
/// 端点种上 httpOnly session cookie（第二跳，让 web 首页也同步变已登录）→ emit "authed"。
pub(super) async fn complete_desktop_oauth(
    app: &tauri::AppHandle,
    core: &Arc<AppCore>,
    code: &str,
) -> Result<(), String> {
    let tok = core
        .gateway
        .device_token_exchange(code)
        .await
        .map_err(|e| e.to_string())?;
    let jwt = tok.token.clone();
    keychain::store(&StoredCredential {
        jwt: tok.token.clone(),
        expires_at: tok.expires_at.clone(),
    })
    .map_err(|e| e.to_string())?;
    *core.auth.lock().await = AuthState::authed_from(tok);

    if let Some(home) = app.get_webview_window(HOME_WINDOW) {
        let sc = core
            .gateway
            .session_code(&jwt)
            .await
            .map_err(|e| e.to_string())?;
        let url: tauri::Url = format!(
            "{}/api/auth/session-from-code?code={}",
            core.gateway.base_url(),
            sc.code,
        )
        .parse()
        .map_err(|e| format!("bad session-from-code url: {e}"))?;
        home.navigate(url).map_err(|e| e.to_string())?;
    }

    app.emit("authed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 前端（web 首页里的「使用 Google 登录」按钮）触发：系统默认浏览器打开 OAuth 起点。
/// Google 禁止在内嵌 WebView 里走 OAuth 授权（报 "This browser or app may not be
/// secure"），故不能像密码登录那样留在 WebView 内导航；系统浏览器完成登录后，gateway
/// 302 到桌面渠道各自的 deep link scheme（`crate::channel::deep_link_scheme()`），由
/// `complete_desktop_oauth` 接回。`channel` 查询参数告诉 gateway 该跳哪个 scheme——
/// gateway 把它原样存进 `lingxi_oauth_desktop` cookie，回传给桥接页
/// `apps/web/src/auth/DesktopOAuthComplete.tsx`（见该文件的 scheme 映射，须与
/// `crate::channel::deep_link_scheme()` 保持一致）。
#[tauri::command]
pub(super) async fn open_oauth_in_browser(
    app: tauri::AppHandle,
    core: State<'_, Arc<AppCore>>,
    provider: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let channel = crate::channel::name();
    let url = format!(
        "{}/api/auth/{provider}/start?client=desktop&channel={channel}",
        core.gateway.base_url()
    );
    eprintln!("[open_oauth_in_browser] opening: {url}");
    // `tauri_plugin_opener::open_url` 在 macOS 上走 `open::that_detached`——detached spawn，
    // 不等待子进程退出/不查退出码，子进程侧任何失败（参数不对、协议未注册等）在这里都是
    // Ok(())，前端拿不到任何错误信号。这里把最终 URL 打到 stderr，出问题时能直接核对
    // 是不是 URL 本身有问题（而不是盲猜）。
    app.opener().open_url(&url, None::<&str>).map_err(|e| {
        eprintln!("[open_oauth_in_browser] open_url failed for {url}: {e}");
        e.to_string()
    })
}

/// 登出：清 keychain，回 Unauthed。
#[tauri::command]
pub(super) async fn logout(core: State<'_, Arc<AppCore>>) -> Result<(), String> {
    keychain::clear().map_err(|e| e.to_string())?;
    *core.auth.lock().await = AuthState::Unauthed;
    Ok(())
}

/// 前端查询当前是否已登录。
#[tauri::command]
pub(super) async fn is_authed(core: State<'_, Arc<AppCore>>) -> Result<bool, String> {
    Ok(core.auth.lock().await.is_authed())
}
