# Hermes Container Image

灵犀的每个用户跑一个独立的 Hermes 容器。本目录是该容器镜像的源代码——`Dockerfile` + HTTP 包装层 + Hermes 配置。

源自同事的 PoC (`uwf-azure/container/`),改动:
- `server.py` 加 `session_id` + `source` 参数,内部传 hermes `--continue` / `--source`,实现 Web 多 thread / 微信 / CLI 来源的对话历史隔离
- 其余 (Dockerfile / entrypoint.sh / hermes-config.yaml) 原样

---

## HTTP 契约

| 路由 | 用途 |
|---|---|
| `GET /health` | 健康检查 → `{"status":"ok"}` |
| `POST /chat` | body `{message, session_id?, source?}` → `{reply, session_id, exit_code}` |

`session_id` 默认 `"main"`,`source` 默认 `"web"`。Gateway 传 `web:thr_xxx` 之类按 thread 隔离。

---

## 本地构建 + 跑

```bash
cd <repo root>
docker build -t hermes-local docker/hermes/

# 准备 Anthropic Claude key (一次性)
cp docker/hermes/.env.example docker/hermes/.env
# 编辑 docker/hermes/.env 把 ANTHROPIC_API_KEY 改成 Anthropic Claude key

# 跑(单用户本地 dev,挂个本地目录当 volume)
docker run --rm -p 8080:8080 \
  -v ~/.hermes-dev:/home/hermes \
  --env-file docker/hermes/.env \
  hermes-local

# 测
curl http://localhost:8080/health
curl -X POST http://localhost:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好","session_id":"web:thr_a","source":"web"}'
```

首次 build 约 10-15 分钟(拉 3.5GB image + Hermes + playwright + chromium)。之后改 `server.py` 重 build 约 20 秒(layer 缓存命中)。

---

## 推 ACR (生产前)

```bash
# 方式 A: 本地 build + push (网慢时不推荐)
docker tag hermes-local acrlingxidev.azurecr.io/hermes:v1
az acr login -n acrlingxidev
docker push acrlingxidev.azurecr.io/hermes:v1

# 方式 B: ACR Build (云端 build,首推)
az acr build --image hermes:v1 --registry acrlingxidev docker/hermes/
```

---

## 多用户本地隔离 (可选)

不同用户挂不同 volume + 不同端口:

```bash
docker run -d --name hermes-alice -p 8080:8080 \
  -v ~/.hermes-alice:/home/hermes --env-file docker/hermes/.env hermes-local

docker run -d --name hermes-bob -p 8081:8080 \
  -v ~/.hermes-bob:/home/hermes --env-file docker/hermes/.env hermes-local
```

Gateway 的 `container_mapping.container_url` 分别写 `http://localhost:8080` 和 `:8081`。

---

## 跟运行时的关系

```
docker/hermes/  (源代码,git 里)
       ↓ docker build
   hermes image (3.5GB)
       ↓
   ├ 本地: docker run → 一个容器进程
   └ 生产: push 到 ACR → 用 Azure SDK 建 Container App (每用户一个)
```

`docker/hermes/` 本身不部署。它是 image 的源,build 完就没它的事了。

---

## Phase 1.5 (Azure 部署) 加 CI

```yaml
# .github/workflows/hermes-image.yml (待加)
on:
  push:
    paths: [docker/hermes/**]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v1
        with: { creds: ${{ secrets.AZURE_CREDS }} }
      - run: az acr build --image hermes:${{ github.sha }} \
                          --registry acrlingxidev \
                          docker/hermes/
      - run: az containerapp update ... # 更新默认 tag
```

这样 image build/push 跟用户 provisioning 完全解耦,provisioning 永远只是 `az containerapp create --image hermes:<current>`,22 秒搞定。

---

## 关键约束 (改 Dockerfile 前必看)

1. **Hermes 必须装到 `/opt/hermes-agent`** (镜像只读层)。装到 home 会被 volume 覆盖,老用户跑不到新版本
2. **`PIP_USER` + `PYTHONUSERBASE` + `NPM_CONFIG_PREFIX` 三个 env 必须设**——少一个就会出现"用户装的工具重启后丢失"
3. **`api_key: ${ANTHROPIC_API_KEY}` 占位符**——明文 key 不能落 volume
4. **`ThreadingHTTPServer` 必须用**——单线程在 ACA 必被 probe 5 次失败强杀
5. **构建时 `UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python`** ——否则 uv 拉 Python 落到 /root/.local (权限 700),非 root 用户的 venv python 软链悬空

详细见 `~/Downloads/uwf-azure/docs/03-known-issues.md`。
