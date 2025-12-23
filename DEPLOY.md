# Render 部署指南

## 部署步骤（云端同步版本）

### 0. 总览（会创建 3 个资源）

- **Web Service**：`mindmap-api`（Node/Express API）
- **PostgreSQL**：`mindmap-db`（存账号与所有文件数据）
- **Static Site**：`mindmap-web`（前端）

> 这样同一账号在不同 PC/手机登录后，会从云端加载并自动同步所有内容。

### 1. 在 Render 创建资源（推荐用 `render.yaml` 一键创建）

1. 登录 [Render](https://render.com)
2. 点击 **New + → Blueprint**
3. 选择你的 GitHub 仓库（包含本项目根目录的 `render.yaml`）
4. Render 会自动创建：
   - `mindmap-api`（Web Service）
   - `mindmap-db`（Postgres）
   - `mindmap-web`（Static Site）

### 2. 配置前端的 API 地址（关键）

Static Site 需要知道 API 的地址。部署完成后：

1. 打开 `mindmap-api` 的服务页面，复制它的 URL（形如 `https://mindmap-api-xxxx.onrender.com`）
2. 打开 `mindmap-web` → **Environment** → 添加/更新：
   - `VITE_API_URL=https://mindmap-api-xxxx.onrender.com`
3. 重新部署 `mindmap-web`（触发一次新的 build）

### 3. 本地开发（可选）

- 前端：`npm run dev`
- 后端：

```
cd server
npm install
DATABASE_URL=... JWT_SECRET=dev FRONTEND_ORIGIN=http://localhost:5173 npm run dev
```

### 4. 旧版说明（仅静态站）已废弃

旧版只用 localStorage，无法跨设备同步。现在必须同时部署 API + DB。

### 3. 环境变量（可选）

通常不需要环境变量，但如果需要可以添加：
- `NODE_ENV=production`

### 4. 部署

点击 **"Create Static Site"**，Render 会自动：
1. 从 GitHub 拉取代码
2. 运行 `npm install`
3. 运行 `npm run build`
4. 将 `dist` 目录的内容发布到 CDN

### 5. 访问

部署完成后，Render 会给你一个 URL，类似：
```
https://mindmap-web.onrender.com
```

## 注意事项

- ✅ **使用 Static Site**：这是静态网站，不需要 Web Service
- ✅ **免费版可用**：Static Site 免费版完全够用，不需要 SSH
- ✅ **自动部署**：每次推送到 GitHub 会自动重新部署
- ⚠️ **构建时间**：免费版构建可能需要几分钟
- ⚠️ **休眠**：免费版 Web Service 会休眠，但 Static Site 不会

## 如果遇到问题

1. **构建失败**：检查 Build Log，通常是依赖问题
2. **404 错误**：确认 Publish Directory 是 `dist`
3. **空白页面**：检查浏览器控制台，可能是路径问题，需要在 `vite.config.ts` 设置 `base`

## 优化建议

如果部署后路径有问题，可以在 `vite.config.ts` 添加：

```typescript
export default defineConfig({
  base: '/',
  plugins: [react()],
});
```

