# 微信图片附件支持 — 实现方案 (P1: 只做图片)

> 第一步只跑图片,目的是把"iLink 解密 → 落盘 → agent 看见 → 用完即清"整条链路打通,
> 暴露所有真实坑;file/voice/video 留 P2 复用同套骨架。

## 1. 目标与非目标

**目标:**
- 微信端发**图片** → agent 在 prompt 里拿到本地绝对路径,可直接用 vision 工具处理
- 图片落 `/home/hermes/.hermes/cache/images/`,7 天自动清,默认不进云盘
- 单图 > 10 MB 直接拒,sendText 提示用户

**本期不做:**
- 文件 / 语音 / 视频 (P2)
- 出站 (agent 主动发图给微信用户) (P3)
- web 端历史消息里图片缩略图渲染 (P2 顺手)
- 云盘"转正"自动化 (agent 自己用现有 `cloud-file put` 就行)
- NFS 子目录 quota (基建活,另议)

## 2. 链路总览

```
微信用户发图
  │
  ▼
iLink getupdates  ← apps/gateway/src/wechat-ilink/poll-loop.ts (今天就有)
  │   msg.item_list 含 {type:2, image_item:{media:{aes_key, encrypt_query_param}}}
  ▼
parseInbound      ← inbound.ts  [改:返回结构化 parts 而不是单 string]
  │
  ▼
inbound-handler   ← inbound-handler.ts  [改:串起下面 wake + A-E]
  │
  ├─ ★ wake hermes 容器 (新文件 container-warm-cache.ts, 见 §3.7) — 仅有图时执行
  │
  │   warmCache.get(userId) > now-60s?
  │     是 → 跳过 (99% 走这条, text 路径每次成功响应都会续 cache)
  │     否 → GET <container>/health (60s timeout 覆盖 ACA 冷启动 ~15s)
  │           成功 → warmCache.set(userId, now), 继续往下
  │           失败 → sendText "助理还在初始化", return (不下 CDN, 不入库, 不 dispatch)
  │
  ├─ A+B. **打开 streaming pipeline** (新文件 wechat-media-fetcher.ts + inbox-uploader.ts):
  │
  │   fetch(cdn_url).body                          ← iLink CDN, ReadableStream
  │       ↓
  │   sizeCounter Transform                        ← 超 10 MB → destroy 整条管道
  │       ↓
  │   createDecipheriv('aes-128-ecb', key, null)   ← Node 原生 Transform, PKCS7 unpad
  │       ↓
  │   fetch(<container>/inbox/image, {             ← POST 到 hermes 容器
  │     method:'POST', body: 上面这个 stream,
  │     duplex:'half',                             ← Node 18.17+ fetch ReadableStream body
  │     headers: { Content-Type, Authorization, X-Filename }
  │   })
  │
  │   失败 (CDN 4xx/5xx, 解密错, size abort, 容器 500):
  │     gateway 抛对应 Error,inbound-handler 捕获 → sendText 提示
  │     容器侧 .partial 临时文件自动 unlink (见 §3.3)
  │
  │   成功:容器侧 .partial → rename 到正式名,返回
  │     resp: { path: "/home/hermes/.hermes/cache/images/img_xxxxxxxxxxxx.jpg",
  │             size, content_type }
  │
  ├─ C. 入库 messages
  │     content_type='json', content={ text, attachments:[{kind:'image', cache_path, size}] }
  │
  ├─ D. 拼 hermes prompt 字符串 (见 §6.2)
  │
  └─ E. dispatchHermesChat (跟今天一模一样)
        │
        ▼
        hermes CLI 拿到 prompt,绝对路径在文本里
        → 多模态 LLM (qwen-vl-plus) / vision skill / python PIL 都能直接吃
```

## 3. 关键设计决策

### 3.1 Streaming proxy:不走 Blob,也不在 gateway 内存缓冲完整图
- 临时附件零云存储成本;只占 NFS 共享池里那个用户子目录
- 路径直接复用 hermes 主线 (`NousResearch/hermes-agent` `gateway/platforms/base.py:568` 定义的 `$HERMES_HOME/cache/images/`),将来若改用 hermes 自带 weixin gateway 路径无需迁移
- **gateway 只做 stream 中转,不持有完整文件**:`fetch(cdnUrl).body → sizeCounter (Transform) → createDecipheriv('aes-128-ecb') (Transform) → fetch(<container>/inbox/image, { body: stream, duplex:'half' })`,gateway 内存占用 ≈ 几个 16 KB chunk,与文件大小无关
- P2 上文件/视频时同一根 pipeline 直接复用,不怕 100 MB 视频把 gateway 撑爆

### 3.2 TTL = 7 天,**双触发**清理
- **容器 entrypoint 启动**:`find ~/.hermes/cache -type f -mtime +7 -delete`。ACA scale-to-zero 是天然 cron,几乎所有用户每天都会冷启动至少一次
- **每次 `/inbox` 落盘后 best-effort**:同样的 find,异步触发,失败也不阻塞响应。覆盖"长时间在线用户"
- 不引入 cron / sweeper 进程 / DB 元数据表 — mtime 是足够的真值源

### 3.3 大小硬上限 10 MB(streaming abort + 半截清理)
- 微信原图典型 2-8 MB,压缩图 < 2 MB,10 MB 覆盖 95% 真实流量
- **三层闸门叠加**:
  1. iLink push 若给了 `file_size` 元数据,fetcher 在打开 CDN 连接前预判超限直接拒,**根本不下载**
  2. 没给 size 元数据时,sizeCounter Transform 累计字节超 `maxBytes + 16` (PKCS7 padding 余量) 主动 destroy 整条 pipeline,触发上下游全 abort
  3. ACA 侧 `/inbox/image` 落盘时也累计 bytes 二次校验(防 gateway 这层被绕过)
- **streaming 半截写入清理**:容器 handler 写到 `cache/images/.tmp-img_<uuid>.jpg.partial`,EOF 正常才 `rename` 到正式名;任何 abort/异常进 finally `unlink` 临时文件
- 拒了之后 gateway sendText "图片过大 (X MB,上限 10 MB),请截图或压缩后重发"

### 3.4 DB 用现成的 `content_type='json'` 字段
- `packages/db/src/schema.ts:196` 早就有 `messageContentTypeEnum = ['text', 'json']`
- `content` 是 jsonb,改 payload 不需要 migration
- 文本消息走法不变;带附件消息存 `{text, attachments}`
- 前端历史渲染暂时 fallback: `content_type === 'json'` 时显示 `content.text + "(含 N 张图片)"` 占位 (P2 做缩略图)

### 3.5 Hermes 容器侧:`/inbox/image` 一个新路由,不动 `/chat`
- chat dispatch payload 维持纯 string 不变,所有"图片"事实通过文件系统 + prompt 文本传递
- 将来加 `/inbox/document` `/inbox/audio` `/inbox/video` 是 N 个独立小 handler,互不影响

### 3.6 Content-Type 推断:信 iLink hint,不嗅探 magic bytes
- streaming 模式下嗅探 magic bytes 要预读前 16 字节再 push 回 stream,实现繁琐
- iLink push 通常在 `image_item.media` 里给图片格式提示,直接用
- 拿不到 hint 时 default `image/jpeg`(微信 99% 是 jpg)
- 容器侧落盘扩展名按 content_type 推导;agent 用 vision 工具调用时,content_type 错了最多报错一次,不构成安全风险

### 3.7 Wake-then-stream:files 链路有图就先唤醒 ACA,再开 streaming pipeline

**问题:** 今天 text 路径调 `/chat` 是"原地等冷启动"—— small JSON body,gateway 持有 0 上游连接,等多久都不疼。但 files 链路是 `fetch(CDN).body → decipher → POST(/inbox/image, duplex:'half')`,**POST 在 ACA 冷启动期间被挂住时,gateway 没人从 CDN body 里 pull**,微信 CDN 的 ~30-60s idle timeout 一到主动 RST,decipher 收到半截密文 PKCS7 unpad 必败,整张图作废。冷启动 P50 ~15s,这条 race 用户基本必撞。

**决策:** files 链路把"等冷启动"显式塞到 streaming 之前 —— 先 `GET /health` 把 replica 唤醒,再开 pipeline。

- **进程内 per-user warm-cache (60s TTL)**:`apps/gateway/src/lib/container-warm-cache.ts` 维护 `Map<userId, lastOkAt>`。命中 → 0 RTT 跳过 wake;miss → 串行 `GET /health` (60s timeout 覆盖冷启动)。
- **所有 ACA 成功 2xx 续 cache**:`callHermesChat` / `dispatchHermesChat` / `deleteHermesSession` / `uploadImageStream` 任一返回 2xx 后调 `noteContainerActivity(userId)`。稳态下 99% 的 files 调用直接走 cache。
- **wake 失败 → sendText "助理还在初始化",不下 CDN**:60s 还没起来的容器是真挂,不是冷启动。继续打只会让 CDN 也跟着挂、用户更长时间等失败提示。
- **text 路径不改**:小 body 没有 CDN 那种被挂死的资源,沿用今天"硬等"的简单语义;给它加 wake 反而让 cold-start case 多一个串行 RTT (wake + chat = 1.5x cold start),且 `docs/known-issues.md:61` 已经明确否决过。
- **in-flight dedupe**:同 user 并发 inbound 同时 wake → 用 `Map<userId, Promise>` 折成一次 `/health`。

**为什么不延用 text 的"原地等":** files 跟 text 三个差别:
1. files 把 CDN 连接挂在冷启动窗口里 → CDN 主动 RST 几乎必然
2. `/inbox/image` 是同步 ack(必须等 `{ path, size }` 才能拼 prompt 派发),不像 `/chat` 拿 202 就走;冷启动代价被放大成"持有连接 N 倍时长"
3. 同条消息多图 fan-out 在 `maxReplicas=1` 的容器上是串行写,任一被 cold-start 拖死后续都受影响

(完整推导见会话研究记录,本节是落点结论。)


## 4. 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/shared/src/contracts.ts` | 改 | 新增 `WechatAttachmentRef` / 扩展 `MessageContent` 类型 |
| `apps/gateway/src/wechat-ilink/inbound.ts` | 改 | `parseInbound` 返回 `parts: InboundPart[]` 而非单 `text: string` |
| `apps/gateway/src/wechat-ilink/wechat-media-fetcher.ts` | 新 | 打开 iLink CDN → sizeCounter → AES-128-ECB decipher 的 **streaming pipeline**,返回 ReadableStream |
| `apps/gateway/src/wechat-ilink/inbox-uploader.ts` | 新 | 把上面 stream POST 到 `${containerUrl}/inbox/image` (duplex:'half'),不做应用层重试 |
| `apps/gateway/src/lib/container-warm-cache.ts` | 新 | `ensureContainerWarm` + `noteContainerActivity` + `ContainerWakeError`,wake-then-stream 主入口 (Task 5.5) |
| `apps/gateway/src/lib/aca-call.ts` | 改 | (a) 加 `getContainerToken(userId)` 内部 helper (Task 4 鉴权小节), 4 个出站请求都加 `Authorization: Bearer <token>`; (b) `callHermesChat` / `dispatchHermesChat` / `deleteHermesSession` 成功 2xx 后调 `noteContainerActivity`,让 text 路径的成功响应也喂 warm-cache |
| `apps/gateway/src/wechat-ilink/inbound-handler.ts` | 改 | 串起 fetch → upload → 拼 prompt → dispatch |
| `apps/gateway/src/db/threads-dao.ts` 或 `messages` 写入处 | 改 | `messages.insert` 接受 json content |
| `apps/gateway/src/db/users-dao.ts` | (引用) | 现有 `getTokenVersion(userId)` 复用,**不改**, `aca-call.ts:getContainerToken` 调用 |
| `apps/gateway/src/wechat-ilink/wechat-media-fetcher.ts` | (见上) | `export const WECHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;` 写死在 fetcher 顶部, uploader 直接 import 用作 `X-Max-Bytes` header 值 (单一源, 不进 env) |
| `docker/hermes/server/http.ts` | 改 | (a) 加 `requireBearer` helper, 给 `/history` `/chat` `/session` `/inbox/image` **4 端点统一套上**(`/health` 留给 probe 不校);(b) 加 `handleInboxImage` 路由分发 |
| `docker/hermes/server/inbox.ts` | 新 | streaming 接收 → 写 `.partial` → rename;sweep 7 天前文件 + 孤儿 `.partial` |
| `docker/hermes/server/config.ts` | 改 | 加 `INBOX_CACHE_TTL_DAYS=7` |
| `docker/hermes/entrypoint.sh` | 改 | 加启动时 sweep find 命令 |
| `apps/gateway/test/wechat-ilink/inbound.test.ts` | 改 | 现有图片"返回 null"的断言反过来 |
| `apps/gateway/test/wechat-ilink/inbound-handler.test.ts` | 新/改 | mock fetcher + uploader,断言完整链路 |
| `apps/gateway/test/wechat-ilink/wechat-media-fetcher.test.ts` | 新 | AES 解密单测 (rfc 测试向量) |
| `apps/gateway/test/lib/container-warm-cache.test.ts` | 新 | cache hit/miss + in-flight dedupe + timeout/5xx 抛 `ContainerWakeError` |
| `docker/hermes/test/inbox.test.ts` | 新 | 落盘 + sweep 单测 |

---

## 5. 任务拆分

### Task 1 — shared 类型扩展
**文件:** `packages/shared/src/contracts.ts`

```ts
// 微信附件在 hermes 容器内的引用 (临时缓存,7 天 TTL)
export interface WechatAttachmentRef {
  kind: 'image';                  // P2 扩 'file'|'voice'|'video'
  cache_path: string;             // 容器内绝对路径, e.g. /home/hermes/.hermes/cache/images/img_xxx.jpg
  content_type: string;           // image/jpeg | image/png | ...
  size: number;
}

// 当 message.content_type === 'json' 时, content 解释为:
export interface MessageJsonContent {
  text: string;                   // 用户文字部分,无文字时为 ''
  attachments: WechatAttachmentRef[];
}
```

**验证:** `pnpm --filter @lingxi/shared build` 通过。

---

### Task 2 — `parseInbound` 改返回结构化 parts

**文件:** `apps/gateway/src/wechat-ilink/inbound.ts`

```ts
export type InboundPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; aes_key_b64: string; encrypt_query_param: string; size_hint?: number };

export interface WechatInbound {
  message_id: string;
  from_user_id: string;
  context_token: string;
  parts: InboundPart[];           // ← 替代旧的 text: string
}
```

解析规则:
- `item.type === 1` → text part
- `item.type === 2` → image part,读 `item.image_item.media.aes_key` + `media.encrypt_query_param`;缺字段则跳过该 item (不让整条消息 null)
- `type ∈ {3,4,5}` (voice/file/video) → **本期仍跳过,但在 §Task 8 加 sendText 提示** "暂仅支持图片"
- 全部 parts 都跳过且无 text → 仍返回 null

**注意**:`from_user_id` 早期判定保留;`message_type==2 (bot 自己)` / `message_state==1 (流式生成中)` 过滤逻辑不动。

**测试改:** `inbound.test.ts:38-40` 那条"image 返回 null"反过来断言 part。`52-60` 的"text+image only 取 text"改成"两个 part 都取到"。

---

### Task 3 — iLink CDN 流式拉 + AES-128-ECB 流式解密

**新文件:** `apps/gateway/src/wechat-ilink/wechat-media-fetcher.ts`

```ts
import { createDecipheriv } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';

const WECHAT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

export interface DecryptedImageStream {
  body: ReadableStream<Uint8Array>;   // 已串好 sizeCounter + AES-128-ECB Decipher
  content_type: string;               // 来自 iLink hint, fallback 'image/jpeg' (§3.6)
  size_hint?: number;                 // iLink push 给了就有, 否则 undefined
}

export class MediaTooLargeError extends Error {
  constructor(public actual: number, public limit: number) { super(`media too large: ${actual} > ${limit}`); }
}
export class MediaDownloadError extends Error {}
export class MediaDecryptError extends Error {}

/**
 * 打开一条 CDN → 解密 stream pipeline。**不在 gateway 内存里缓冲完整文件**。
 *
 * - 调用方负责把返回的 `body` pipe 到下游 (inbox-uploader);
 * - size abort 走 sizeCounter Transform, 一旦超 (maxBytes + 16 PKCS7 padding 余量) 主动 destroy
 *   整条 pipeline, 上游 fetch 取消、下游 POST body 中断 (容器侧 .partial 文件由 §Task 4 清掉);
 * - AES key 先按 base64 解, 失败 fallback hex (hermes 主线 weixin.py 同款兜底)。
 */
export async function openDecryptedImageStream(part: {
  aes_key_b64: string;
  encrypt_query_param: string;
  content_type_hint?: string;
  size_hint?: number;
}, opts: { maxBytes: number; fetchImpl?: typeof fetch }): Promise<DecryptedImageStream>;
```

实现要点:
1. URL = `${WECHAT_CDN_BASE}?${encrypt_query_param}` (来自 hermes 主线 `gateway/platforms/weixin.py`, 常量 `WEIXIN_CDN_BASE_URL`)
2. **size hint 预判**: 若 `part.size_hint > maxBytes` 立即抛 `MediaTooLargeError`, 不开 fetch
3. `fetch(cdnUrl, { signal: AbortSignal.timeout(30000) })`, 失败抛 `MediaDownloadError`
4. key: try `Buffer.from(aes_key_b64, 'base64')`, 长度 ≠ 16 时 fallback `Buffer.from(aes_key_b64, 'hex')`, 仍 ≠ 16 抛 `MediaDecryptError`
5. **pipeline 构造** (用 `node:stream/web` interop):
   ```ts
   const sizeCounter = new Transform({
     transform(chunk, _, cb) {
       count += chunk.length;
       if (count > maxBytes + 16) { cb(new MediaTooLargeError(count, maxBytes)); return; }
       cb(null, chunk);
     }
   });
   const decipher = createDecipheriv('aes-128-ecb', key, null);  // PKCS7 unpad 自动
   const nodeReadable = Readable.fromWeb(resp.body!);
   const piped = nodeReadable.pipe(sizeCounter).pipe(decipher);
   return { body: Readable.toWeb(piped) as ReadableStream<Uint8Array>, content_type: ..., size_hint: ... };
   ```
6. content_type: `part.content_type_hint || 'image/jpeg'` (§3.6)

**单测** (`wechat-media-fetcher.test.ts`):
- 用 `createCipheriv('aes-128-ecb', key, null)` 现场加密一段固定 plain → mock fetch 返回 cipher → 跑 pipeline → 读 web stream → 断言解密回原文
- 喂超大 plain (12 MB),断言 stream consumer 端拿到 `MediaTooLargeError`
- aes_key 喂 hex 编码,断言 fallback 成功
- size_hint > maxBytes,断言 fetch 没被调用 (mock 上挂 spy)

---

### Task 4 — Hermes 容器 `/inbox/image` 端点(streaming 接收 + .partial → rename)

**⚠️ Step 0 (开工第一步, 必做):验证 Bun.serve streaming request body**

`docker/hermes/server/` 历史所有 handler 都是 `await req.json()`,**从没处理过 streaming POST**。Task 4 的 streaming 接收方案能否实现取决于 Bun.serve 在 `for await (req.body)` + `duplex:'half'` 客户端协商下能否真的 chunk-by-chunk 流式读。**不验证就开写,顶到一半才发现 Bun 有 bug,设计要回炉**。

30 行 smoke test 即可:
```ts
// docker/hermes/scripts/smoke-streaming.ts (跑完就删, 不进 git)
Bun.serve({ port: 18080, async fetch(req) {
  let n = 0, chunks = 0;
  for await (const chunk of req.body!) { n += chunk.length; chunks++; }
  return Response.json({ received_bytes: n, chunks });
}});
// 另开终端:
//   dd if=/dev/urandom of=/tmp/big.bin bs=1M count=8
//   curl -X POST --data-binary @/tmp/big.bin -H 'Content-Type: application/octet-stream' http://localhost:18080/
// 期待: chunks > 1 (证明真的是 stream 不是一次性 buffer), received_bytes = 8388608
```

- chunks=1 或抛错 → Bun 在我们当前版本(`@types/bun: ^1.3.0`, `docker/hermes/package.json`)不支持,回退方案:`await req.arrayBuffer()` 全 buffer,容器内存峰值 ≤ 12 MB(10MB image + overhead),hermes 容器 2 GiB 撑得住。
- chunks > 1 → 走原计划的 streaming + backpressure,继续 Task 4 正篇。

**改:** `docker/hermes/server/http.ts`
- 加 `requireBearer(req)` helper (复用 `LAIFU_USER_TOKEN`)
- `handle()` dispatch 给 `/history` `/chat` `/session` `/inbox/image` **4 个端点**统一套上,401 走 `Response.json({error:'unauthorized'}, {status:401})`
- `/health` 不校(ACA readiness/liveness probe 用,见 `docs/known-issues.md:11`)
- 路由分发追加 `POST /inbox/image` → `handleInboxImage`

**新文件:** `docker/hermes/server/inbox.ts`

```ts
const IMAGE_CACHE_DIR = path.join(process.env.HERMES_HOME!, 'cache/images');
const TTL_MS = (Number(process.env.INBOX_CACHE_TTL_DAYS) || 7) * 86400_000;
// 二次防线: 默认 10MB, 但实际 cap 由 gateway 出站 X-Max-Bytes header 决定 (gateway 是单一源)
const HARD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

export async function handleInboxImage(req: Request): Promise<Response> {
  // 1. Bearer 校验 (复用 LAIFU_USER_TOKEN, 由 §鉴权小节的 requireBearer 在 handle() 分发前已校;此处假设已通过)
  // 2. Content-Type 推扩展名: image/jpeg → .jpg, image/png → .png, 其它 → .bin;
  //    读 `X-Max-Bytes` header → cap = Number(...) || HARD_MAX_BYTES_DEFAULT
  // 3. 生成最终名 finalName = `img_${randomHex(12)}${ext}`;
  //    临时名  partial = `.tmp-${finalName}.partial`
  // 4. 用 Bun.write 不行 (要 streaming + 累计计数), 走 Node fs.createWriteStream:
  //    - await mkdir IMAGE_CACHE_DIR
  //    - const out = createWriteStream(path.join(IMAGE_CACHE_DIR, partial))
  //    - 用 Web Streams API: for await (const chunk of req.body) {
  //        bytesWritten += chunk.length;
  //        if (bytesWritten > cap) throw new Error('exceeds X-Max-Bytes');
  //        if (!out.write(chunk)) await once(out, 'drain');   // backpressure
  //      }
  //    - await new Promise(r => out.end(r));
  // 5. 成功: await rename(partial → finalName), 返回
  //    { path: absolute, size: bytesWritten, content_type }
  // 6. 异常路径 (catch + finally):
  //    - await unlink(partial).catch(noop)
  //    - 5xx Response with { error: ... }
  // 7. 成功后异步 sweepOldFiles(IMAGE_CACHE_DIR, TTL_MS).catch(noop)
}

async function sweepOldFiles(dir: string, ttlMs: number): Promise<void> {
  // for-of readdir → stat → mtime < now-ttlMs → unlink, 全程 .catch 吞错
  // 同时清孤儿 .partial (mtime > 5 min, 一定是死掉的上传)
}
```

**鉴权 (4 端点统一 Bearer):**
- 今天 `/chat` `/history` `/session` 都裸奔,只靠 container_url 不公开撑安全(URL 只有 32 bit 熵, 见 §6 风险 #5)。**本期一起补上**, 避免单独再开 PR
- **容器侧校验**:`Authorization: Bearer <jwt>` → `verifyLaifuUserToken(jwt, { secret: env.GATEWAY_SECRET, expectedVersion: env.LAIFU_USER_TOKEN_VERSION })`;失败 401(`GATEWAY_SECRET` 已由 gateway `buildSpec` 注入,见 dynamic-update-aca 试点;本 Task 仅补容器侧消费)
- **gateway 侧出站签 token (集中 helper, 4 处复用)** — `apps/gateway/src/lib/aca-call.ts` export 一个 helper:
  ```ts
  // apps/gateway/src/lib/aca-call.ts  (export 给 inbox-uploader.ts 复用)
  export const getContainerToken = async (userId: string): Promise<string> => {
    const v = await dao.users.getTokenVersion(userId);   // 已存在: apps/gateway/src/db/users-dao.ts:44
    if (v == null) throw new Error(`no token_version for user ${userId}`);
    return signLaifuUserToken({ userId, tokenVersion: v, secret: config.auth.gatewaySecret });
  };
  ```
  4 个出站函数 (`callHermesChat` / `dispatchHermesChat` / `deleteHermesSession` / `uploadImageStream`) 内部各调 `await getContainerToken(userId)` 一次,加进 `Authorization` header。**uploader 不再从外面接 `containerToken` 参数**(Task 5 已调整)。
- token_version 不缓存:稳态下 user 不会频繁刷新,每个 chat 1 select 可接受;若实测 DB 压力大再加 LRU
- **容器侧 requireBearer helper (~10 行):**
  ```ts
  // docker/hermes/server/http.ts
  function requireBearer(req: Request): Response | null {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return Response.json({error:'unauthorized'}, {status:401});
    try {
      verifyLaifuUserToken(auth.slice(7), { secret: TOKEN_SECRET, expectedVersion: TOKEN_VERSION });
      return null;
    } catch { return Response.json({error:'unauthorized'}, {status:401}); }
  }
  ```

**单测** (`docker/hermes/test/inbox.test.ts`):
- 正常上传一个 ReadableStream → 文件落到正式名, `.partial` 不存在, 返回 path/size 对
- 上传中途 client abort → `.partial` 被 unlink, 正式名不存在
- body 超 HARD_MAX_BYTES → 同上 + 返回 5xx
- sweep: 预置 8 天前文件 + 1 天前文件 + 6 分钟前的 `.partial` 孤儿 → 跑 sweep → 只剩 1 天前的
- **Bearer 鉴权**: 无 `Authorization` header / 错 token / 过期 token → 4 个端点全部 401, body 无副作用(不创建 .partial、不跑 hermes、不读 state.db)
- **Bearer 鉴权 happy path**: 同样 4 个端点带正确 token → 正常 200/202(用现有 4 个 handler 的最小 happy case stub)

---

### Task 5 — gateway 侧 inbox streaming uploader

**新文件:** `apps/gateway/src/wechat-ilink/inbox-uploader.ts`

```ts
export interface UploadedAttachment {
  cache_path: string;
  content_type: string;
  size: number;
}

export async function uploadImageStream(args: {
  containerUrl: string;
  userId: string;                      // ← 内部用 getContainerToken(userId) 自取 Bearer, 不再从外面传
  body: ReadableStream<Uint8Array>;    // 来自 openDecryptedImageStream
  contentType: string;
  filename?: string;                   // 可选, 仅作日志/header X-Filename
  fetchImpl?: typeof fetch;
}): Promise<UploadedAttachment>;
```

实现要点:
1. `const token = await getContainerToken(userId);` — 复用 `apps/gateway/src/lib/aca-call.ts` 集中的 helper(详见 §鉴权小节 + Task 4),内部做 `dao.users.getTokenVersion + signLaifuUserToken`
2. `fetch(\`${containerUrl}/inbox/image\`, { method:'POST', body: args.body, duplex:'half', headers: { 'Content-Type': args.contentType, 'Authorization': \`Bearer ${token}\`, 'X-Max-Bytes': String(WECHAT_IMAGE_MAX_BYTES), 'X-Filename': args.filename ?? '' }, signal: AbortSignal.timeout(60_000) })`
3. **不做应用层重试** — streaming body 一旦消费就没了, 重试要从 fetcher 重新打开 CDN 连接, 跨模块重试得 inbound-handler 层做 (P2 再考虑)
4. resp 4xx/5xx → `log.warn({ event:'wechat.image.upload.failed', user_id, status, err })`, 抛 Error;`MediaTooLargeError` 由 gateway 上游 fetcher 抛出, uploader 这里 propagate
5. 成功:`log.info({ event:'wechat.image.upload.ok', user_id, size, content_type, upload_ms })`, resp body 是 `{ path, size, content_type }` JSON, 直接 return
6. 成功后调 `noteContainerActivity(userId)` (Task 5.5),把这次 200 当作 warm proof 喂进 cache,后续图片 / text 调用直接命中

**单测** (`inbox-uploader.test.ts`):
- mock fetch 验 method/url/headers/duplex 正确
- body 是 `ReadableStream`, 内容写一段已知 bytes, mock 容器侧 accept, 断言 fetch body 收到完整 bytes
- 容器侧 5xx → 抛 Error

---

### Task 5.5 — container-warm-cache + wake-then-stream 接入

**目的:** files 链路里 CDN streaming pipeline 跟 `/inbox/image` POST 是耦合的——POST 在 ACA 冷启动期间被挂住,gateway 端就拉不动 CDN body,微信 CDN 的 ~30-60s idle timeout 一到必 RST,整张图作废。所以**先唤醒、再开 pipeline**,把"等冷启动"塞到 streaming 之前。

**新文件:** `apps/gateway/src/lib/container-warm-cache.ts`

```ts
import { log } from './logger.js';

// ACA scale-to-zero cooldown 默认 5 min, 实测 8-10 min;
// 60s TTL 给 10x 安全余量, 真冷启动只多 1 个 health 往返。
const WARM_TTL_MS = 60_000;
const WAKE_TIMEOUT_MS = 60_000;       // ACA cold start P99 < 30s, 60s 留余量

export class ContainerWakeError extends Error {}

const warmAt = new Map<string /* userId */, number>();
const inFlight = new Map<string, Promise<void>>();

/** text/chat/upload 任何一次成功 2xx 后调一次,把 cache 续上 */
export const noteContainerActivity = (userId: string): void => {
  warmAt.set(userId, Date.now());
};

export const ensureContainerWarm = async (
  userId: string,
  containerUrl: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<void> => {
  const last = warmAt.get(userId);
  if (last && Date.now() - last < WARM_TTL_MS) return;     // 99% 走这条

  const existing = inFlight.get(userId);
  if (existing) return existing;                            // 同 user 并发 dedupe

  const p = doWake(userId, containerUrl, opts?.fetchImpl ?? fetch)
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
};

const doWake = async (userId: string, containerUrl: string, fetchImpl: typeof fetch): Promise<void> => {
  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetchImpl(`${containerUrl}/health`, {
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ContainerWakeError(`wake fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ms = Math.round(performance.now() - t0);
  if (!resp.ok) throw new ContainerWakeError(`wake non-2xx: ${resp.status}`);
  warmAt.set(userId, Date.now());
  log.info({ event: 'aca.wake', user_id: userId, wake_ms: ms, cold: ms > 1500 });
};
```

**为什么 `/health` 是合适的 wake target:**
- `docker/hermes/server/http.ts:40-42` 的 `handleHealth` 单行 `Response.json({ status: 'ok' })`,纯 CPU 零 IO
- ACA HTTP scaler 对任何 ingress 请求都触发 0→1,`/health` 跟 `/chat` 等价唤醒
- 无 body / 无鉴权(本来就是 ACA probe 自己用的端点),fetch fail 后可立即重试,不像 streaming POST 消费 body 就废了

**接入点 (集中改一处:`apps/gateway/src/lib/aca-call.ts`):**

所有 ACA 调用 2xx 后顺手 `noteContainerActivity(userId)`,把 text 路径的成功响应也喂给 warm-cache,让 files 几乎全部命中:
- `callHermesChat` resp.ok 后
- `dispatchHermesChat` 收到 202 后
- `deleteHermesSession` resp.ok 后
- `uploadImageStream` (Task 5) resp.ok 后

**为什么 text 路径自己不引入 wake:**
- text 调用是单次 `POST /chat` 小 JSON body,gateway 持有 0 上游连接,冷启动期间没人会 RST 它
- 加 wake 反而让 text 的 cold-start case 多一个串行 RTT (wake + chat = 1.5x cold-start time),劣化
- `docs/known-issues.md:61` 已经明确否决过给 `/chat` 加 probe — 仍然适用
- files 加 wake 不是为了省 RTT,是为了避免 streaming pipeline 在冷启动期间被 CDN-side timeout 打断

**单测** (`apps/gateway/test/lib/container-warm-cache.test.ts`):
- cache miss → 调 `/health`;`warmAt` set 后第二次 ensureContainerWarm 不调 fetch
- cache 命中后 `noteContainerActivity` 续期, 61s 后 miss 再调(**用 `vi.useFakeTimers() + vi.advanceTimersByTime(61_000)`**,别真等)
- 并发两个 ensureContainerWarm 同 user → fetch 只被调一次 (in-flight dedupe)
- fetch timeout / 5xx → 抛 `ContainerWakeError`,**warmAt 不更新**
- `cold: ms > 1500` 字段在快/慢两种 mock fetch 下各 assert 一次

---

### Task 6 — `inbound-handler` 串起整条链路

**改:** `apps/gateway/src/wechat-ilink/inbound-handler.ts`

`makeHandleInbound` 内部主流程改成:

```ts
const msg = parseInbound(raw);
if (!msg) return;

// slash / handleWechatNew / resolveThread 跟今天一样, 用 textOf(msg.parts) 替换 msg.text
const text = msg.parts.filter(p => p.kind==='text').map(p => p.text).join('');
const imageParts = msg.parts.filter(p => p.kind==='image');

// slash 拦截只看 text (符合直觉:"/new" 带图也应该走 new)
const slash = classifyMessage(text);
if (slash.kind === 'intercept') { ... 现有逻辑 ... }

const threadId = await resolveThread(binding);

// 配额 + container ready 提前到这里,因为后面 inbox upload 也要容器活着
const mapping = dao.cache.get(binding.user_id);
if (!ready) { safeSendText(CONTAINER_NOT_READY_TEXT); return; }
if (quotaExhausted) { safeSendText(QUOTA_EXHAUSTED_TEXT); return; }

// ★ wake hermes 容器 (避免冷启动期间 CDN 连接被挂着导致 RST, 见 §3.7)
// 仅在有图片要传时才 wake; 纯文本沿用今天"原地等"的策略
if (imageParts.length > 0) {
  try {
    await ensureContainerWarm(binding.user_id, mapping.container_url);
  } catch (e) {
    log.warn({ event: 'wechat.image.wake.failed', user_id: binding.user_id, err: String(e) });
    await safeSendText(CONTAINER_NOT_READY_TEXT);    // 与 mapping 未 ready 的文案合并 (见 §6.11)
    return;                                          // 不下 CDN, 不入库, 不 dispatch
  }
}

// 对每张图: 打开 streaming pipeline, 一次性消费 (没有 retry; 失败 swallow)
// **故意串行**: 容器 maxReplicas=1, 同时 N 个 POST 在单 replica 上 fight CPU + sync fs write,
// 串行更稳;P2 加 file/voice/video 时也维持这个语义。
const attachments: WechatAttachmentRef[] = [];
const fetchErrors: string[] = [];
for (const img of imageParts) {
  try {
    const stream = await openDecryptedImageStream(img, { maxBytes: WECHAT_IMAGE_MAX_BYTES });
    const up = await uploadImageStream({
      containerUrl: mapping.container_url,
      userId: binding.user_id,            // ← uploader 内部自取 token (见 §鉴权小节 / aca-call.ts getContainerToken)
      body: stream.body,                  // ← streaming, gateway 不持有完整 bytes
      contentType: stream.content_type,
    });
    attachments.push({ kind:'image', cache_path: up.cache_path, content_type: up.content_type, size: up.size });
  } catch (e) {
    if (e instanceof MediaTooLargeError) {
      await safeSendText(`图片过大 (${(e.actual/1e6).toFixed(1)} MB,上限 ${(e.limit/1e6).toFixed(0)} MB),请压缩或截图后重发。`);
      // 此图丢弃, 其它正常继续; 容器侧的 .partial 已由 Task 4 finally 自动清
    } else {
      log.warn({ event:'wechat.image.fetch.failed', err: e.message });
      fetchErrors.push(`(一张图片下载失败: ${e.message})`);
      // 容器侧 .partial 也由 Task 4 finally 清
    }
  }
}

// 全部 image 都失败且没文字 → 不入库不 dispatch,已经 sendText 了
if (attachments.length === 0 && !text) return;

// 入库 (新 json 格式)
await dao.messages.insert({
  id: userMsgId, thread_id: threadId, role:'user',
  content_type: attachments.length > 0 ? 'json' : 'text',
  content: attachments.length > 0 ? { text, attachments } : text,
  source: 'wechat',
});

// 拼 prompt 给 hermes
const prompt = buildHermesPrompt(text, attachments, fetchErrors);

await dispatchHermesChat({ ..., message: prompt });  // 其余跟今天一样
```

prompt 构造 (`buildHermesPrompt` 独立小函数,便于单测):

```
[微信附件] 用户发送了 N 张图片,已下载到本地:
- /home/hermes/.hermes/cache/images/img_xxxxxxxxxxxx.jpg (image/jpeg, 1.2 MB)
- /home/hermes/.hermes/cache/images/img_yyyyyyyyyyyy.png (image/png, 240 KB)

可用 vision 工具或 python PIL 直接读这些路径处理。

用户原文: <text 或 "(无文字说明)">
<可选: ⚠️ ${fetchErrors.length} 张图片下载失败>     ← 计数由 buildHermesPrompt 动态生成
```

---

### Task 7 — entrypoint 启动 sweep

**改:** `docker/hermes/entrypoint.sh` (在 Step 1 seed 之后, Step 2 bootstrap 之前插一段)

```bash
# ============ Step 1.5: cache TTL sweep ============
# 清理 7 天前的微信附件 (image/document/audio/video);ACA scale-to-zero 是天然 cron。
CACHE_DIR="$HOME_DIR/.hermes/cache"
if [ -d "$CACHE_DIR" ]; then
  find "$CACHE_DIR" -type f -mtime +7 -delete 2>/dev/null || true
  find "$CACHE_DIR" -type d -empty -delete 2>/dev/null || true
  echo "[entrypoint] cache sweep done"
fi
```

---

### Task 8 — voice/file/video 显式提示 (P1 范围内的最小友好性)

`parseInbound` 在 §Task 2 跳过 voice/file/video 之外,需要把"看到了 unsupported part"这个事实**带出来**,让 inbound-handler 能 sendText 提示一次:

```ts
export interface WechatInbound {
  ...
  parts: InboundPart[];
  unsupported_hints: string[];    // 新加:["语音消息暂不支持", ...]
}
```

`inbound-handler` 在 dispatch 之前若 `unsupported_hints.length > 0`,先 sendText 拼接的提示(去重);然后**继续按 text + image 走**(不阻塞)。

---

### Task 9 — 端到端真机验证

**前置:** dev 环境绑定一个真微信号,gateway 跑 azure dev。

测试用例:
| 场景 | 预期 |
|---|---|
| 纯文字 | 跟今天一样,链路无回归 |
| 单图 (压缩,~500 KB) | hermes 收到 prompt 含路径;agent 能 cat / 调 vision 描述图片内容 |
| 单图 (原图,~5 MB) | 同上;`time` 测端到端延迟 (gateway fetch+decrypt+upload 总耗时) |
| 单图 12 MB | sendText "图片过大",DB 无 row,容器无 dispatch |
| 文字 + 1 图 | prompt 同时含原文 + 路径 |
| 文字 + 1 视频 | sendText "视频消息暂不支持";文字仍走 dispatch |
| 同 thread 连发 3 图 (单条消息) | 3 个 attachment 都入库;3 个文件落在 cache/images/ |
| 容器未 ready (provisioning 中) | sendText "助理还在初始化",不下载 (避免浪费 CDN 配额) |
| 容器侧 cache 里塞一个 7 天前的旧文件,触发容器冷启动 | 启动后该文件被 sweep |
| **冷启动场景**: ACA 强制 sleep (`az containerapp revision deactivate` 后立即重发图) | gateway 日志看到 `aca.wake cold=true`,等 ~15s 后用户正常收到回复;CDN 无 RST 报错 |
| **warm-cache 命中**: 连发两条带图消息,间隔 < 60s | 第二条日志 **无** `aca.wake` event (直接复用 cache);上传延迟比第一条短 5-30s |
| **wake 真失败**: 防火墙临时 block ACA → 发图 | gateway 60s 超时后 sendText "助理正在启动...",日志 `event: wechat.image.wake.failed`,CDN **未被打开** (验 fetch spy 0 call) |
| **text 路径无回归**: 容器冷状态下发纯文字 | 沿用今天行为 (硬等 cold start),`callHermesChat` 成功后顺手 `noteContainerActivity`,下一条图片消息直接走 warm cache |
| **context_token TTL 实测** (§6 #12): 发一条入站消息记下 `context_token`, 等 0/30/60/90s 后分别 sendText 一次 | 找出 TTL 临界值;若 < 60s 则 `WAKE_TIMEOUT_MS` 缩到 TTL-5s |

进 ACA 容器 `exec ls -la ~/.hermes/cache/images/` 看实际文件;Kusto 拉 gateway 的 `event: wechat.image.upload.ok` 日志看分布。

---

## 6. 风险与开放问题 (落实施前确认)

1. **iLink CDN 字段名 100% 准确性** — `image_item.media.aes_key` + `encrypt_query_param` 来源于 NousResearch/hermes-agent `gateway/platforms/weixin.py` (主线代码,2026-06 commit)。生产联调时若 iLink 改字段需对照修。
2. **`aes_key` 编码** — hermes 主线注释"密钥可能以原始 base64 或十六进制编码形式到达——适配器两种格式均支持"。`wechat-media-fetcher.ts` 实现里要兜底 try base64 → 失败 try hex。
3. **多模态 LLM 配置** — 当前 `HERMES_PROVIDER=alibaba`,`HERMES_MODEL=qwen3-coder-plus` 不带 vision。要让 agent "看见"图片得切到 `qwen-vl-plus` 或装 vision skill。P1 验收标准是 **prompt 里有路径 + agent 能 cat / ls 确认文件存在**,真"看懂图"是 model 选择问题,留到 P1 实现后单独评估。
4. **gateway 内存占用** — streaming pipeline 下,每张图 gateway 持有的字节数 ≈ Node stream highWaterMark (默认 16 KB) × 几个 buffered chunk,与文件大小无关。即使 P2 上 100 MB 视频也不会撑爆 App Service B1。
5. **容器 4 端点 Bearer 鉴权** — 今天 `/chat` `/history` `/session` 都没校,只靠"container_url 不公开"撑安全(其实 URL 只是 32 bit 熵,见 `apps/gateway/src/provisioning/azure.ts:27` 的 `appNameFor`)。**本期顺手把 4 个业务端点(`/health` 留给 ACA probe 不校)统一套上 Bearer**,复用 `LAIFU_USER_TOKEN` + 现有 `signLaifuUserToken`,见 Task 4 鉴权小节。**网络层内网化(CAE `internal:true` + App Service VNet integration)是另一个独立 PR**,跟本 feature 解耦,不动 `container_mapping.container_url`;完整调研见 [internal-net.md](./internal-net.md)。**⚠️ 本期把 `gateway-secret` 下放到每个 ACA 后,secret 轮换需要走 dual-secret 共存期才能无中断**;Task 4 的 `requireBearer` 实现必须支持 `GATEWAY_SECRET_PREVIOUS` env fallback,详见 [secret-rotation.md](./secret-rotation.md)。
6. **图片大小预判字段** — iLink 是否在 `image_item.media` 里给 `file_size` 之类要联调确认。给了走 §3.3 闸门 1 (不开 fetch 直接拒),没给靠 sizeCounter Transform 流式 abort (§3.3 闸门 2)。
7. **streaming 半截写入** — 解密 abort / 网络断 / 容器 5xx 时, gateway 端 stream 提前 destroy → 容器侧 `for await (chunk)` 抛 → finally `unlink .partial`。本设计已覆盖 (§Task 4),但要 cover 一种 corner: 容器**进程崩了**留下孤儿 `.partial` —— sweep 函数加了 "孤儿 .partial mtime > 5 min 也清" 的逻辑兜底 (§Task 4 sweepOldFiles)。
8. **重试策略缺失** — streaming body 一旦消费就不能重放。fetcher / uploader 内都不做应用层重试。失败用户重发即可。如果 P2 实测发现 iLink CDN 抖动率高需要重试,改 inbound-handler 层"从 part 重新开 pipeline"的循环 (而不是在 stream 内重试)。
9. **路径暴露在 prompt 里 → 是否泄漏给 LLM 调用方** — `cache_path` 是容器内绝对路径,不含用户标识 (uuid 文件名),即便 LLM echo 也不算敏感。安全。
10. **warm-cache TTL 选择** — Task 5.5 用 60s TTL,前提是 ACA scale-to-zero cooldown ≥ 5 min(微软文档默认值,实测经验 8-10 min)。若未来调整 ACA scale 规则、cooldown 改短到接近 60s,会出现"warm-cache 命中但 replica 已 sleep"的假阳性 → 第一张图 POST 仍踩 cold start,sendText 会回 fetch 错而非 wake 错。日志埋了 `aca.wake cold=true/false`,实测命中率异常再调短 TTL。
11. **wake 失败 vs 真冷启动** — `ensureContainerWarm` 60s 还没 200,认定 wake 失败,sendText "助理正在启动..." 后 return。**这跟 text 路径 `mapping.status !== 'ready'` 文案合并到同一句** (CONTAINER_NOT_READY_TEXT),避免文案分裂;但日志要分别打 `event: wechat.image.wake.failed` 跟 `wechat.container.not_ready` 区分根因。
12. **iLink `context_token` TTL 未知** — wake 失败要等到 60s 超时才 sendText,期间 token 可能已过期 → 用户视角"消息发出去没任何反馈"。**真机联调阶段必须实测**:发一条消息记下 context_token,N 秒后 sendText 看是否仍能成功;Task 9 加了用例。若实测 < 60s,把 `WAKE_TIMEOUT_MS` (`container-warm-cache.ts`) 缩到 TTL-5s,牺牲冷启动 P99 覆盖率换 sendText 可用性。
13. **ContainerMappingCache 陈旧 `container_url`** — 沿用今天行为,**本期不修**。该 cache 启动时 loadAll 一次,之后只在 provisioning 路径主动 set,**外部 DB 改动不同步**(详见 `docs/known-issues.md` §#3)。如果用户 ACA 被重建/灾备过、URL 变了,gateway wake/upload 都会打到旧 URL → 504 / DNS fail → 用户看 "助理正在启动" 文案。真机若反复出现,先看是不是这个,而不是 wake 逻辑本身。
14. **日志 event 命名约定** — 统一 `wechat.image.<阶段>.<结果>`:`wechat.image.wake.failed` (Task 6) / `wechat.image.fetch.failed` (Task 6 fetcher) / `wechat.image.upload.ok` (Task 5 uploader 成功) / `wechat.image.upload.failed` (Task 5 uploader 异常)。**唯一不属于 wechat.image.* 命名空间的是 `aca.wake`** (Task 5.5),因为它是通用 wake helper、跨 channel 共用,留单独 namespace。

## 7. 时间估算

- Task 1-3: 0.5d (shared 类型 + parseInbound + fetcher)
- Task 4-5: 1.0d (Bun streaming smoke test 0.25d + 容器 inbox + uploader + 4 端点 Bearer + `getContainerToken` helper)
- Task 5.5: 0.25d (container-warm-cache + wake-then-stream 接入, 见 §3.7)
- Task 6: 0.5d (inbound-handler 串联 + DB 切 json)
- Task 7-8: 0.25d (sweep + unsupported 提示)
- Task 9 真机验证: 0.5d (含 hermes 镜像 rebuild + push + ACA rollout 一轮)

**总计:** ~3 day,单人。Task 4 Step 0 smoke test 失败的话回退到 buffered upload 还要再加 ~0.25d 改 inbox handler 实现。

## 8. P2 预留 (本期完成后顺势可做)

- 复用 `wechat-media-fetcher` + `/inbox/{document,audio,video}` 把 file/voice/video 加上
- web 端历史消息渲染图片缩略图 (走容器代理读 cache_path → 签 SAS-like 临时 token)
- agent 主动"保存到云盘":已经有 `cloud-file put`,无需新工作
- NFS 子目录 quota 调研 (撑爆共享池的最后一道闸)
