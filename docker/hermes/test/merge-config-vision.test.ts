// merge-config-vision.test.ts — mergeConfig 的 vision 路由配置单测 (bun test)。
//
// 背景: 真机微信发图, v16 写 model.supports_vision:true 让主模型 qwen3.7-max 走 native,
// 但 DashScope compatible-mode 端点不接受图像 content → 400。v17/18 改为给"主模型不吃原生图"
// 的 provider 配 auxiliary.vision 走专用 VL 模型 (qwen-vl-max) 的文字描述路, 并删除 supports_vision。
//
// VL 模型名由 gateway 经 env HERMES_VISION_MODEL 注入 → cfg.vision_model (旧 PROVIDER_VISION_MODEL
// 硬编码映射已删); 改模型只需重部署 gateway, 不必 rebuild 镜像。写 auxiliary.vision 的闸 =
// vision_model 非空 && base_url 在场 (后者 ⟺ DASHSCOPE_BASE_URL 必注入, 端点覆盖到位)。
//
// 这里只断言 mergeConfig 的纯函数输出 (不碰网络/文件)。端到端真凭据是镜像内 renderConfigYaml 实测 + 真机识图。

import { test, expect } from 'bun:test';
import { mergeConfig } from '../scripts/pull-runtime-config.ts';

const ALIBABA_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

test('vision_model + base_url 在场 → 写 auxiliary.vision(无 base_url), 不写 supports_vision', () => {
  const doc = mergeConfig(null, { provider: 'alibaba', model: 'qwen3.7-max', base_url: ALIBABA_BASE, vision_model: 'qwen-vl-max' });
  const aux = doc.auxiliary as Record<string, unknown> | undefined;
  expect(aux).toBeDefined();
  // base_url 绝不写进 config: 否则 hermes call_llm(vision) 把它当显式 base_url → provider
  // 强制成 custom → 读 OPENAI_API_KEY(空) → 401。端点改由 env DASHSCOPE_BASE_URL 覆盖。
  expect(aux!.vision).toEqual({ provider: 'alibaba', model: 'qwen-vl-max' });
  expect((doc.model as Record<string, unknown>).supports_vision).toBeUndefined();
});

test('注入的 VL 模型名透传 (env HERMES_VISION_MODEL → cfg.vision_model → auxiliary.vision.model)', () => {
  // 换一个模型名, 证明不再走硬编码 qwen-vl-max, 而是 cfg.vision_model 原样写入。
  const doc = mergeConfig(null, { provider: 'alibaba', model: 'qwen3.7-max', base_url: ALIBABA_BASE, vision_model: 'qwen-vl-plus' });
  const vision = (doc.auxiliary as Record<string, Record<string, unknown>>).vision;
  expect(vision).toEqual({ provider: 'alibaba', model: 'qwen-vl-plus' });
});

test('auxiliary.vision 不内联 api_key / base_url (密钥+端点从 env 取, 不落 NFS)', () => {
  const doc = mergeConfig(null, { provider: 'alibaba', model: 'qwen3.7-max', base_url: ALIBABA_BASE, vision_model: 'qwen-vl-max' });
  const vision = (doc.auxiliary as Record<string, Record<string, unknown>>).vision;
  expect('api_key' in vision).toBe(false);
  expect('base_url' in vision).toBe(false);
});

test('清掉旧 volume 残留的 model.supports_vision (v16→v17 升级)', () => {
  const stale = { model: { default: 'old', supports_vision: true, base_url: ALIBABA_BASE } };
  const doc = mergeConfig(stale, { provider: 'alibaba', model: 'qwen3.7-max', base_url: ALIBABA_BASE, vision_model: 'qwen-vl-max' });
  expect((doc.model as Record<string, unknown>).supports_vision).toBeUndefined();
});

test('无 base_url → 不写 auxiliary.vision (即使 vision_model 在场; 避免落国际站默认端点 → 401)', () => {
  const doc = mergeConfig(null, { provider: 'alibaba', model: 'qwen3.7-max', base_url: null, vision_model: 'qwen-vl-max' });
  expect(doc.auxiliary).toBeUndefined();
});

test('vision_model 空 → 不写 auxiliary.vision (operator opt-out / 主模型本身吃图走 native)', () => {
  // 即使 base_url 在场, 只要 gateway 不注入 HERMES_VISION_MODEL (空) → 不配 vision。
  const doc = mergeConfig(null, { provider: 'anthropic', model: 'claude-opus-4', base_url: ALIBABA_BASE, vision_model: null });
  expect(doc.auxiliary).toBeUndefined();
  expect((doc.model as Record<string, unknown>).supports_vision).toBeUndefined();
});

test('vision_model 撤掉 → 删掉残留的 auxiliary.vision (delete-on-absence)', () => {
  const stale = { auxiliary: { vision: { provider: 'alibaba', base_url: ALIBABA_BASE, model: 'qwen-vl-max' } } };
  const doc = mergeConfig(stale, { provider: 'anthropic', model: 'claude-opus-4', base_url: null, vision_model: null });
  expect(doc.auxiliary).toBeUndefined();
});

test('保留 auxiliary 下的其他任务配置 (只动 vision)', () => {
  const stale = { auxiliary: { compression: { model: 'cheap-model' }, vision: { provider: 'x' } } };
  const doc = mergeConfig(stale, { provider: 'alibaba', model: 'qwen3.7-max', base_url: ALIBABA_BASE, vision_model: 'qwen-vl-max' });
  const aux = doc.auxiliary as Record<string, unknown>;
  expect(aux.compression).toEqual({ model: 'cheap-model' });
  expect(aux.vision).toEqual({ provider: 'alibaba', model: 'qwen-vl-max' });
});

test('保留 model 其他字段 + display clamp 不受影响', () => {
  const doc = mergeConfig(null, { provider: 'alibaba', model: 'qwen3.7-max', base_url: ALIBABA_BASE, vision_model: 'qwen-vl-max' });
  expect((doc.model as Record<string, unknown>).provider).toBe('alibaba');
  expect((doc.display as Record<string, unknown>).tool_progress).toBe('off');
});
