## mindmap-web（云端同步版）

这是一个支持：导图 / 流程图 / 文档 / 手写笔记 的轻量应用。

### 关键能力
- **账号系统**：注册/登录
- **云端同步**：同一账号在不同 PC/手机登录后自动同步所有内容

### 本地开发

- 前端：

```bash
npm install
npm run dev
```

- 后端（需要 Postgres）：

```bash
cd server
npm install
# 例：DATABASE_URL=postgres://...  JWT_SECRET=dev  FRONTEND_ORIGIN=http://localhost:5173
npm run dev
```

- 前端需要配置 API 地址：

```bash
# 在项目根目录新建 .env.local
VITE_API_URL=http://localhost:10000
```

### 部署到 Render
看 `DEPLOY.md`（Blueprint + Postgres + 设置 `VITE_API_URL`）。
