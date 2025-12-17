# Render 部署指南

## 部署步骤

### 1. 在 Render 创建 Static Site

1. 登录 [Render](https://render.com)
2. 点击 **"New +"** → 选择 **"Static Site"**（不是 Web Service！）
3. 连接你的 GitHub 仓库

### 2. 配置设置

在 Render 的配置页面填写：

- **Name**: `mindmap-web`（或你喜欢的名字）
- **Branch**: `main`（或你的主分支名）
- **Root Directory**: 留空（或填写 `mindmap-web` 如果项目在子目录）
- **Build Command**: 
  ```
  npm install && npm run build
  ```
- **Publish Directory**: 
  ```
  dist
  ```

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

