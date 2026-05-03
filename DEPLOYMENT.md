# YYZ_CLAW Deployment

## 启动模式

### 开发启动

```powershell
npm start
```

开发启动会执行：

- 构建前端到 `frontend/dist`
- 后端直接运行 `backend/src`
- 不生成 `backend-dist`
- 不生成 Electron 安装包

### Electron 开发启动

```powershell
npm run electron:dev
```

Electron 开发启动会打开 Electron 窗口，但仍然使用开发链路：

- 前端现场构建 `frontend/dist`
- 后端直接运行 `backend/src`
- 不生成安装包
- 不使用安装版的 `app.asar`

### 正式打包

```powershell
npm run electron:dist
```

正式打包会执行：

1. `npm run build`
2. 生成前端产物 `frontend/dist`
3. 运行 `scripts/prepare-electron-package.mjs`
4. 生成压缩后的后端运行产物 `backend-dist`
5. 使用 `electron-builder` 生成安装包

输出位置：

```text
release/YYZ_CLAW Setup 0.1.0.exe
release/win-unpacked/
```

## 安装版运行逻辑

安装版启动时不会重新构建前端，也不会重新生成后端产物。

运行流程：

```text
YYZ_CLAW.exe
-> electron/main.cjs
-> 启动 service.js
-> service.js 发现 backend-dist/src 存在
-> 后端运行 backend-dist/src
-> 前端复用 frontend/dist
```

安装包中应用代码会进入：

```text
resources/app.asar
```

Native 模块会进入：

```text
resources/app.asar.unpacked
```

## Git 提交规则

应该提交：

- `backend/src`
- `frontend/src`
- `electron`
- `scripts`
- `resources/defaults`
- `package.json`
- `package-lock.json`

不应该提交：

- `node_modules`
- `backend-dist`
- `frontend/dist`
- `release`
- `.yyz` 中的用户数据
- `models`
- `config`
- `tmp`
- 日志文件

## 常见问题

### 安装版启动一直停在启动页

先查看后端日志：

```powershell
Get-Content "$env:APPDATA\agent-framework-workspace\logs\backend.err.log" -Encoding UTF8 -Tail 120
Get-Content "$env:APPDATA\agent-framework-workspace\logs\backend.out.log" -Encoding UTF8 -Tail 120
```

常见原因：

- 端口 `3000` 被占用
- 根 `package.json` 漏了后端运行依赖
- native 模块没有被正确打包到 `app.asar.unpacked`

### 图标没有刷新

如果 exe 已经写入新图标，但资源管理器仍显示旧图标，重启资源管理器：

```powershell
Stop-Process -Name explorer -Force
Start-Process explorer.exe
```

### node-pty 打包失败

当前配置使用：

```json
"npmRebuild": false
```

这是为了避免打包时重新编译 `node-pty`，否则 Windows BuildTools 缺少 Spectre 运行库时会失败。

如果要重新编译 native 模块，需要安装 Visual Studio Build Tools 对应架构的 Spectre-mitigated libraries。

## 产物保护说明

当前保护方式是：

- 前端只发布 `frontend/dist`
- 后端发布 `backend-dist`，JS 会被 minify
- 应用代码进入 `app.asar`

这不是加密，不能防止强逆向；它的目标是避免安装目录直接暴露完整源码，并提高解包后的阅读成本。
