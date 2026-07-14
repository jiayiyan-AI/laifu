//! JWT 续期守护逻辑（文档 §11.4）。
//!
//! 设备 JWT 90 天有效 + 7 天宽限（gateway `auth-refresh.ts`：`LIFETIME_SECONDS=90d`,
//! `GRACE_DAYS=7`）。只要宽限期内开过一次就能无限续。本模块提供**纯判定**：
//! 给定当前 JWT 的 `exp` 与 now，是否该续、是否已彻底过期（超宽限、需重登）。
//!
//! 实际网络调用（`POST /api/auth/refresh-token`）由 `state` 层用 `GatewayClient`
//! 执行；把判定与 IO 分开，判定可纯函数测试。

use chrono::{DateTime, Duration, Utc};

/// exp 前多少天进入"该续期"窗口。文档 §11.4：exp 前 7 天内每次启动都续。
pub const REFRESH_BEFORE_EXPIRY_DAYS: i64 = 7;
/// 宽限天数，与 gateway `auth-refresh.ts` `GRACE_DAYS` 对齐。超过则续期端点也会 401。
pub const GRACE_DAYS: i64 = 7;

/// 基于 `expires_at` 的续期决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshDecision {
    /// 距过期还远（> 7 天），无需动作。
    Fresh,
    /// 进入续期窗口（exp 前 7 天内，或已过期但仍在宽限内）→ 应调 refresh-token。
    ShouldRefresh,
    /// 已过期超过宽限（> exp + 7 天）→ refresh 也会 401，必须重登。
    Expired,
}

/// 纯判定：给定 JWT 过期时刻与当前时刻，决定续期动作。
pub fn decide(expires_at: DateTime<Utc>, now: DateTime<Utc>) -> RefreshDecision {
    let grace_deadline = expires_at + Duration::days(GRACE_DAYS);
    if now > grace_deadline {
        return RefreshDecision::Expired;
    }
    let refresh_window_start = expires_at - Duration::days(REFRESH_BEFORE_EXPIRY_DAYS);
    if now >= refresh_window_start {
        return RefreshDecision::ShouldRefresh;
    }
    RefreshDecision::Fresh
}

/// 解析 ISO-8601 `expires_at` 后判定；解析失败保守视为 `ShouldRefresh`
/// （宁可多续一次也不要因坏字符串卡死续期）。
pub fn decide_from_iso(expires_at: &str, now: DateTime<Utc>) -> RefreshDecision {
    match DateTime::parse_from_rfc3339(expires_at) {
        Ok(dt) => decide(dt.with_timezone(&Utc), now),
        Err(_) => RefreshDecision::ShouldRefresh,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn fresh_when_far_from_expiry() {
        // exp 在 90 天后，now 在今天 → Fresh
        let exp = t("2026-10-07T00:00:00Z");
        let now = t("2026-07-09T00:00:00Z");
        assert_eq!(decide(exp, now), RefreshDecision::Fresh);
    }

    #[test]
    fn should_refresh_within_7d_before_expiry() {
        let exp = t("2026-07-09T00:00:00Z");
        let now = t("2026-07-03T00:00:00Z"); // exp 前 6 天
        assert_eq!(decide(exp, now), RefreshDecision::ShouldRefresh);
    }

    #[test]
    fn should_refresh_when_expired_but_within_grace() {
        let exp = t("2026-07-09T00:00:00Z");
        let now = t("2026-07-14T00:00:00Z"); // 过期 5 天，宽限内
        assert_eq!(decide(exp, now), RefreshDecision::ShouldRefresh);
    }

    #[test]
    fn expired_beyond_grace() {
        let exp = t("2026-07-09T00:00:00Z");
        let now = t("2026-07-17T00:00:01Z"); // 过期 8 天余，超 7 天宽限
        assert_eq!(decide(exp, now), RefreshDecision::Expired);
    }

    #[test]
    fn boundary_exactly_at_refresh_window_start() {
        let exp = t("2026-07-09T00:00:00Z");
        let now = t("2026-07-02T00:00:00Z"); // 恰好 exp - 7d
        assert_eq!(decide(exp, now), RefreshDecision::ShouldRefresh);
    }

    #[test]
    fn boundary_exactly_at_grace_deadline_is_still_refresh() {
        let exp = t("2026-07-09T00:00:00Z");
        let now = t("2026-07-16T00:00:00Z"); // 恰好 exp + 7d，未超过
        assert_eq!(decide(exp, now), RefreshDecision::ShouldRefresh);
    }

    #[test]
    fn bad_iso_defaults_to_refresh() {
        assert_eq!(
            decide_from_iso("garbage", t("2026-07-09T00:00:00Z")),
            RefreshDecision::ShouldRefresh
        );
    }
}
