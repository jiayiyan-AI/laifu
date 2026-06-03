# docker/ — 容器镜像源

本目录存放需要构建并推到 Azure Container Registry (ACR) 的镜像源码。
每个子目录 = 一个独立镜像。

## 当前镜像

| 镜像 | 用途 | 部署目标 |
|---|---|---|
| `hermes/` | Hermes Agent 容器，每个用户独立实例 | Azure Container Apps (运行时由 gateway 通过 SDK 创建) |

## 构建发布

```bash
cd hermes
ACR_NAME=<acr-name> ./build-and-push.sh
```

`ACR_NAME` 从 `infra/bicep` 部署输出的 `acrLoginServer` 取前缀 (去掉 `.azurecr.io`)。

构建走 ACR Build (云端原生 amd64)，本地无需 docker daemon。

## 不在这里的东西

- **gateway / web**: 部署成 Node 进程到 App Service，不打镜像。代码在 `apps/`。
- **基础设施**: ACR/Storage/ContainerAppsEnv/AppService 由 `infra/bicep/` 声明。
- **每用户实例**: 运行时由 gateway 通过 Azure SDK 创建，见 `apps/gateway/src/provisioning/azure.ts`。
