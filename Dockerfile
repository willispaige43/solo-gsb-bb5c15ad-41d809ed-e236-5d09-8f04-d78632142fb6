FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 仅拷贝依赖清单，利用构建缓存；全部为纯 JS 依赖，无需编译工具链
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

# --experimental-sqlite：Node 22 中启用内置 node:sqlite 模块
CMD ["node", "--experimental-sqlite", "server.js"]
