fn validate_channel() {
    println!("cargo:rerun-if-env-changed=LAIFU_CHANNEL");
    if let Ok(channel) = std::env::var("LAIFU_CHANNEL") {
        if !matches!(channel.as_str(), "dev" | "canary" | "stable") {
            panic!("LAIFU_CHANNEL must be dev, canary, or stable; got {channel:?}");
        }
    }
}

fn main() {
    validate_channel();
    // 仅在 `app` feature 下真正装配 Tauri（需前端 dist + 各平台系统库）。
    // 默认 feature 下不跑 tauri_build，保证逻辑核心在无 GUI 依赖环境可编译。
    #[cfg(feature = "app")]
    tauri_build::build();
}
