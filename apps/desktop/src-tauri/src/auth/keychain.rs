//! 设备 JWT 的 OS keychain 存储。
//!
//! 长期凭据（90 天可自续 = 长期）不落明文文件，进 OS keychain（`keyring` crate：
//! macOS Keychain / Windows Credential Manager / Linux Secret Service）。
//!
//! `app` feature 专属：`keyring` 依赖各平台系统库。逻辑核心测试不涉及此模块。

use keyring::Entry;

const JWT_USER: &str = "device-jwt";
/// JWT 与其过期时刻一起存（用 `\n` 分隔），续期判定无需解 JWT body。
const SEP: char = '\n';

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("stored credential malformed")]
    Malformed,
}

/// 规则 rs-result-type：错误类型作带默认值的泛型参数暴露。
pub type Result<T, E = KeychainError> = std::result::Result<T, E>;

/// keychain 中的设备凭据：JWT + 过期时刻（ISO-8601）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCredential {
    pub jwt: String,
    pub expires_at: String,
}

fn entry() -> Result<Entry> {
    Ok(Entry::new(crate::channel::keychain_service(), JWT_USER)?)
}

/// 存/覆盖设备凭据。
pub fn store(cred: &StoredCredential) -> Result<()> {
    let packed = format!("{}{}{}", cred.jwt, SEP, cred.expires_at);
    entry()?.set_password(&packed)?;
    Ok(())
}

/// 读设备凭据；无凭据（首次启动/已登出）→ `Ok(None)`。
pub fn load() -> Result<Option<StoredCredential>> {
    match entry()?.get_password() {
        Ok(packed) => {
            let (jwt, expires_at) = packed.split_once(SEP).ok_or(KeychainError::Malformed)?;
            Ok(Some(StoredCredential {
                jwt: jwt.to_string(),
                expires_at: expires_at.to_string(),
            }))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 清除设备凭据（登出/吊销后回 Unauthed）。无凭据也视作成功（幂等）。
pub fn clear() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
