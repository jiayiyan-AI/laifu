//! 桌面渠道（dev / canary / stable，仿 Chrome 命名）：本地开发 / 线上测试环境 / 线上生产环境。
//!
//! 三渠道可在同一台机器上并存安装（各自独立 bundle identifier + deep-link scheme +
//! keychain service + 本地数据目录），互不干扰。渠道由编译期 env `LAIFU_CHANNEL` 注入
//! （`apps/desktop/package.json` 的 `dev`/`dev:canary`/`dev:stable`/`build*` 脚本各自设置），
//! 未设置时默认 `dev`（保持"裸跑 `cargo build`/`cargo test`"时行为不变）。
//!
//! `tauri.conf.json`（stable，无需覆盖文件）/ `tauri.conf.dev.json` / `tauri.conf.canary.json`
//! 三份 Tauri 配置提供各渠道的 `identifier`/`productName`/`mainBinaryName`/deep-link scheme——
//! 这些字段是 OS 级注册信息（Info.plist / Windows 注册表），只能编译期静态声明，因此本模块的
//! `deep_link_scheme()` 必须与对应 `tauri.conf.*.json` 里的 scheme 手动保持一致。
//!
//! gateway/login URL 可由运行时 env 临时覆盖；home URL 不可覆盖，因为它是能调用 native
//! OAuth command 的远程页面，必须与 `capabilities/home-remote.json` 的静态 ACL 白名单一致。
//! 渠道默认值定义了未设可覆盖 env 时使用的值。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    Dev,
    Canary,
    Stable,
}

impl Channel {
    const fn name(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Canary => "canary",
            Self::Stable => "stable",
        }
    }
}

/// 当前编译渠道。`build.rs` 会拒绝除 `dev`、`canary`、`stable` 以外的值；未设时为
/// `dev`。把校验放在 build script 可避免 const-eval 不能比较 `str` 的限制，同时让任何
/// Cargo/Tauri 构建入口都在产物生成前失败。
#[inline]
fn active_channel() -> Channel {
    match option_env!("LAIFU_CHANNEL") {
        Some("canary") => Channel::Canary,
        Some("stable") => Channel::Stable,
        None | Some("dev") => Channel::Dev,
        Some(_) => unreachable!("build.rs validates LAIFU_CHANNEL"),
    }
}

/// gateway base URL 默认值。
/// - dev: 本地开发环境，gateway :9000。
/// - canary: 线上测试环境，`rg-lingxi-dev` 部署（`app-lingxi-dev-gateway`）。
/// - stable: 线上生产环境（`webBaseUrl` 自定义域，见 `infra/bicep/parameters.prod.json`）。
fn gateway_url_for(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => "http://localhost:9000",
        Channel::Canary => "https://app-lingxi-dev-gateway.azurewebsites.net",
        Channel::Stable => "https://laifu.uncagedai.org",
    }
}

/// web 首页 URL 默认值。dev 下前后端跨端口（Vite :3000）；canary/stable 前后端同域
/// （gateway `express.static` 托管 `web/dist`，见 `docs/environments.md`），故与 gateway 同源。
fn home_url_for(channel: Channel) -> String {
    match channel {
        Channel::Dev => "http://localhost:3000/".to_string(),
        Channel::Canary | Channel::Stable => format!("{}/", gateway_url_for(channel)),
    }
}

/// 登录页 URL 默认值，同源规则同 [`home_url_for`]。
fn login_url_for(channel: Channel) -> String {
    match channel {
        Channel::Dev => "http://localhost:3000/login".to_string(),
        Channel::Canary | Channel::Stable => format!("{}/login", gateway_url_for(channel)),
    }
}

/// deep-link URL scheme。必须与对应 `tauri.conf.*.json` 的
/// `plugins.deep-link.desktop.schemes` 手动保持一致（见模块文档）。
fn scheme_for(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => "laifu-dev",
        Channel::Canary => "laifu-canary",
        Channel::Stable => "laifu",
    }
}

/// OS keychain 里存设备 JWT 用的 service 名。渠道间取不同值，保证互不覆盖/误读对方凭据。
fn keychain_service_for(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => "com.lingxi.desktop.dev",
        Channel::Canary => "com.lingxi.desktop.canary",
        Channel::Stable => "com.lingxi.desktop",
    }
}

/// 本地数据目录（相对系统 home 的路径分量），见 `app/core.rs` `LAIFU_HOME`。渠道间隔离
/// `config.json`/`rclone.conf`/SAS 缓存/窗口几何记忆，避免互相踩踏。canary/dev 嵌套在
/// `~/.laifu/` 下面（`canary-data`/`dev-data` 子目录），而非同级独立目录——stable 的路径
/// `~/.laifu/` 保持改动前不变，老用户装机无需迁移；canary/dev 是新增渠道，挂在同一个
/// 顶层目录下便于用户一次性找到/清理所有渠道数据。
fn data_dir_components_for(channel: Channel) -> &'static [&'static str] {
    match channel {
        Channel::Dev => &[".laifu", "dev-data"],
        Channel::Canary => &[".laifu", "canary-data"],
        Channel::Stable => &[".laifu"],
    }
}

/// 窗口标题/托盘提示的渠道后缀，帮用户在同时装了多个渠道时分辨。stable 留空
/// （生产渠道是用户主用的，不需要额外标注）。
fn display_suffix_for(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => "（本地开发）",
        Channel::Canary => "（测试版）",
        Channel::Stable => "",
    }
}

/// 用于 OAuth 起点的规范渠道名；与桌面 URL、scheme 与本地数据目录共用同一已校验值。
pub fn name() -> &'static str {
    active_channel().name()
}

pub fn gateway_base_url_default() -> &'static str {
    gateway_url_for(active_channel())
}

pub fn home_url_default() -> String {
    home_url_for(active_channel())
}

pub fn login_url_default() -> String {
    login_url_for(active_channel())
}

pub fn deep_link_scheme() -> &'static str {
    scheme_for(active_channel())
}

pub fn keychain_service() -> &'static str {
    keychain_service_for(active_channel())
}

pub fn data_dir_components() -> &'static [&'static str] {
    data_dir_components_for(active_channel())
}

pub fn display_suffix() -> &'static str {
    display_suffix_for(active_channel())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_defaults_to_localhost() {
        assert_eq!(Channel::Dev.name(), "dev");
        assert_eq!(gateway_url_for(Channel::Dev), "http://localhost:9000");
        assert_eq!(home_url_for(Channel::Dev), "http://localhost:3000/");
        assert_eq!(login_url_for(Channel::Dev), "http://localhost:3000/login");
        assert_eq!(scheme_for(Channel::Dev), "laifu-dev");
        assert_eq!(keychain_service_for(Channel::Dev), "com.lingxi.desktop.dev");
        assert_eq!(
            data_dir_components_for(Channel::Dev),
            &[".laifu", "dev-data"]
        );
    }

    #[test]
    fn canary_points_at_deployed_dev_gateway() {
        let gw = gateway_url_for(Channel::Canary);
        assert_eq!(Channel::Canary.name(), "canary");
        assert_eq!(gw, "https://app-lingxi-dev-gateway.azurewebsites.net");
        assert_eq!(home_url_for(Channel::Canary), format!("{gw}/"));
        assert_eq!(login_url_for(Channel::Canary), format!("{gw}/login"));
        assert_eq!(scheme_for(Channel::Canary), "laifu-canary");
        assert_eq!(
            keychain_service_for(Channel::Canary),
            "com.lingxi.desktop.canary"
        );
        assert_eq!(
            data_dir_components_for(Channel::Canary),
            &[".laifu", "canary-data"]
        );
    }

    #[test]
    fn stable_points_at_production_domain() {
        let gw = gateway_url_for(Channel::Stable);
        assert_eq!(Channel::Stable.name(), "stable");
        assert_eq!(gw, "https://laifu.uncagedai.org");
        assert_eq!(home_url_for(Channel::Stable), format!("{gw}/"));
        assert_eq!(login_url_for(Channel::Stable), format!("{gw}/login"));
        assert_eq!(scheme_for(Channel::Stable), "laifu");
        assert_eq!(keychain_service_for(Channel::Stable), "com.lingxi.desktop");
        assert_eq!(data_dir_components_for(Channel::Stable), &[".laifu"]);
    }

    #[test]
    fn display_suffix_marks_non_stable_channels() {
        assert_eq!(display_suffix_for(Channel::Stable), "");
        assert_ne!(display_suffix_for(Channel::Canary), "");
        assert_ne!(display_suffix_for(Channel::Dev), "");
    }
}
