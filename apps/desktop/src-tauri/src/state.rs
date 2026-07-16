//! 应用认证与同步状态机。
//!
//! `Unauthed` → 登录拿 session → 换 device JWT → `Authed`。
//! `Authed` 下常驻 JWT 续期 / SAS 刷新 / sync 编排三个 task（在 app 层起）。
//!
//! 这里只定义**状态类型与转移的纯判定**；实际 IO/task 由 app 层驱动。

use crate::contracts::TokenResponse;

/// 认证态。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum AuthState {
    /// 未登录：需打开登录 webview。
    #[default]
    Unauthed,
    /// 已登录：持有设备 JWT 与其过期时刻（ISO-8601）。
    Authed { jwt: String, expires_at: String },
}

impl AuthState {
    pub fn is_authed(&self) -> bool {
        matches!(self, AuthState::Authed { .. })
    }

    /// 拿到设备 token 后进入 Authed。
    pub fn authed_from(token: TokenResponse) -> Self {
        AuthState::Authed {
            jwt: token.token,
            expires_at: token.expires_at,
        }
    }

    /// 续期成功：更新 JWT 与过期时刻，保持 Authed。
    pub fn refreshed(&self, token: TokenResponse) -> Self {
        AuthState::Authed {
            jwt: token.token,
            expires_at: token.expires_at,
        }
    }

    /// 当前 JWT（仅 Authed 有）。
    pub fn jwt(&self) -> Option<&str> {
        match self {
            AuthState::Authed { jwt, .. } => Some(jwt.as_str()),
            AuthState::Unauthed => None,
        }
    }
}

/// 同步运行态，供 UI 展示。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SyncState {
    /// 空闲，等待触发。
    #[default]
    Idle,
    /// 正在跑 bisync。
    Syncing,
    /// 上次同步出错，附消息。
    Error(String),
    /// 需用户处理：如需 resync 恢复，或凭据失效需重登。
    NeedsAttention(String),
}

/// 同步触发去抖：同一时刻只允许一个 bisync，
/// 运行中收到新触发 → 标 dirty，跑完补一次。
#[derive(Debug, Clone, Default)]
pub struct TriggerGate {
    running: bool,
    dirty: bool,
}

impl TriggerGate {
    /// 收到一个触发。返回 true 表示应立即开跑；false 表示已在跑、已标 dirty。
    pub fn on_trigger(&mut self) -> bool {
        if self.running {
            self.dirty = true;
            false
        } else {
            self.running = true;
            true
        }
    }

    /// 一次 bisync 结束。返回 true 表示期间有新触发（dirty），应再跑一次。
    pub fn on_finish(&mut self) -> bool {
        if self.dirty {
            self.dirty = false;
            // 保持 running=true，直接接着跑补偿轮。
            true
        } else {
            self.running = false;
            false
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(jwt: &str) -> TokenResponse {
        TokenResponse {
            token: jwt.into(),
            expires_at: "2026-10-07T00:00:00Z".into(),
        }
    }

    #[test]
    fn default_is_unauthed() {
        assert_eq!(AuthState::default(), AuthState::Unauthed);
        assert!(!AuthState::default().is_authed());
        assert_eq!(AuthState::default().jwt(), None);
    }

    #[test]
    fn authed_from_token() {
        let s = AuthState::authed_from(tok("dev.jwt"));
        assert!(s.is_authed());
        assert_eq!(s.jwt(), Some("dev.jwt"));
    }

    #[test]
    fn refresh_updates_jwt() {
        let s = AuthState::authed_from(tok("old"));
        let s2 = s.refreshed(tok("new"));
        assert_eq!(s2.jwt(), Some("new"));
    }

    #[test]
    fn gate_runs_immediately_when_idle() {
        let mut g = TriggerGate::default();
        assert!(g.on_trigger());
        assert!(g.is_running());
    }

    #[test]
    fn gate_marks_dirty_when_running() {
        let mut g = TriggerGate::default();
        g.on_trigger(); // 开跑
        assert!(!g.on_trigger()); // 运行中再触发 → dirty，不立即跑
    }

    #[test]
    fn gate_compensates_dirty_on_finish() {
        let mut g = TriggerGate::default();
        g.on_trigger();
        g.on_trigger(); // dirty
        assert!(g.on_finish()); // 有 dirty → 补跑
        assert!(g.is_running()); // 补偿轮仍在跑
        assert!(!g.on_finish()); // 无新触发 → 收尾
        assert!(!g.is_running());
    }

    #[test]
    fn gate_idle_after_clean_finish() {
        let mut g = TriggerGate::default();
        g.on_trigger();
        assert!(!g.on_finish());
        assert!(!g.is_running());
    }
}
