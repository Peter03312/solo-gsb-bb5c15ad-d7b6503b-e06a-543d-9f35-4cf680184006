# syntax=docker/dockerfile:1

# ---- 构建阶段：编译 better-sqlite3 原生模块 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 编译 better-sqlite3 所需工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 运行时需要最小依赖（better-sqlite3 预编译产物已静态链接 libstdc++，
# 安装 libstdc++6 保证可加载）
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY public ./public
COPY package.json ./

# 数据库存放目录（挂载为数据卷）
RUN mkdir -p /app/data

ENV PORT=8080 \
    DB_PATH=/app/data/app.db
EXPOSE 8080
VOLUME ["/app/data"]

# 容器健康检查：数据库/进程异常时能被发现
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/server.js"]
