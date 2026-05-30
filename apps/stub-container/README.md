# stub-container

本地测试用的 Hermes Container mock。实现 spec §3 的双点 HTTP 契约：
- `POST /api/chat/start` → `{ stream_id }`
- `GET /api/chat/stream?stream_id=X` → SSE 流（token / tool / done）

仅用于 dev，不上生产。Phase 1.5 切到真实 Hermes Image 后这个就闲置。

## 用法

```bash
cd /Users/yanjiayi/workspace/laifu
pnpm install
pnpm --filter @lingxi/stub-container start
# 默认 :8080；改端口：STUB_PORT=9000 pnpm --filter @lingxi/stub-container start
```

## 验证

```bash
curl -X POST http://localhost:8080/api/chat/start \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"web:test","message":"你好","source":"web"}'
# {"stream_id":"stub_..."}

curl http://localhost:8080/api/chat/stream?stream_id=<above>
# 一连串 event: token / event: tool / event: done
```
