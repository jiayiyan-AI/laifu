#!/usr/bin/env bash
# build-deploy.sh — 生成 App Service 部署单元 app-service-deploy/
#
# 流程:
#   1. vite lib mode 把 gateway TS + @lingxi/shared 打成单文件 dist/index.mjs
#   2. vite 把 web 打成 apps/web/dist/
#   3. 拼装 app-service-deploy/:
#        index.mjs              ← gateway 单文件
#        web-dist/              ← 前端静态资源
#        package.json           ← 只含运行时 deps, 精确版本, 无 workspace:* 协议
#   4. 在 app-service-deploy/ 里 npm install --omit=dev 装运行时依赖
#
# 设计上 mono repo 部署的所有痛点都在这一步消化掉:
#   - workspace:* 协议: vite bundle 把 @lingxi/shared 内联, 部署 pkg 里见不到
#   - pnpm symlink: 部署目录用 npm 装, 100% 扁平真目录
#   - lockfile 漂移: 部署 package.json 从 pnpm-lock 取精确版本
#   - Oryx 黑洞: 配合 WEBSITE_RUN_FROM_PACKAGE=<SAS URL> 完全跳过 Oryx
#
# 完成后:
#   - 本地 smoke test:  cd app-service-deploy && node index.mjs   (需要相应 env)
#   - 打包上传:        cd app-service-deploy && zip -rq ../deploy.zip . -x '*.map'

set -euo pipefail
cd "$(dirname "$0")/.."

OUT="app-service-deploy"

echo "[build-deploy] 1/5 清理 $OUT/"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "[build-deploy] 2/5 build shared (gateway bundle 内联依赖) + vite build gateway"
pnpm --filter @lingxi/shared build >/dev/null
pnpm --filter @lingxi/gateway build >/dev/null

echo "[build-deploy] 3/5 vite build web"
pnpm --filter @lingxi/web build >/dev/null

echo "[build-deploy] 4/5 拼装产物"
# gateway dist/ 已经含全部需要的产物 (index.mjs + index.mjs.map + prompts/),
# 整目录平铺进 $OUT。其中 prompts/ 由 vite copyPromptsPlugin 复制进 dist。
cp -R apps/gateway/dist/. "$OUT/"
cp -R apps/web/dist "$OUT/web-dist"

# 生成 deploy package.json: 只留运行时 deps, 用 pnpm-lock 的精确版本
node scripts/gen-deploy-pkg.mjs

echo "[build-deploy] 5/5 npm install --omit=dev (产扁平 node_modules)"
cd "$OUT"
npm install --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=warn 2>&1 | tail -5
cd ..

# 校验
[ -f "$OUT/index.mjs" ]              || { echo "❌ index.mjs 缺失";                exit 1; }
[ -f "$OUT/web-dist/index.html" ]    || { echo "❌ web-dist/index.html 缺失";       exit 1; }
[ -d "$OUT/node_modules/express" ]   || { echo "❌ express 没装";                  exit 1; }
[ -d "$OUT/node_modules/@azure" ]    || { echo "❌ @azure SDK 没装";               exit 1; }

echo ""
echo "[build-deploy] DONE → $OUT/"
echo "  bundle:        $(du -h "$OUT/index.mjs" | cut -f1)"
echo "  web-dist:      $(du -sh "$OUT/web-dist" | cut -f1)"
echo "  node_modules:  $(du -sh "$OUT/node_modules" | cut -f1)"
echo "  total:         $(du -sh "$OUT" | cut -f1)"
echo ""
echo "本地 smoke test:   cd $OUT && node index.mjs    (需要 env)"
echo "打包部署:         cd $OUT && zip -rq ../deploy.zip . -x '*.map'"
