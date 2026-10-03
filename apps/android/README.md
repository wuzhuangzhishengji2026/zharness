# ZHarness Android（远程模式 · M0）

ZHarness 的安卓客户端。引擎不在手机上——手机是事件日志的又一块**投影**：
App 通过 WebSocket 连接主机端的 `zharness serve`（本仓库新增的移动桥接模式），
对话、时间线、分支分叉等全部能力与桌面端共享同一份 append-only 事件日志。

架构与里程碑见 [docs/ANDROID-DESIGN.zh-CN.md](../../docs/ANDROID-DESIGN.zh-CN.md)。

```
手机 App（本目录）  ⇄  zharness serve（WS + 配对 + resync）  ⇄  引擎 sidecar（--mode rpc）
```

## 两种模式

| 模式 | 引擎跑在哪 | App 连接 | 状态 |
|---|---|---|---|
| **远程模式** | 电脑 / 服务器的 `zharness serve` | 局域网 IP（配对链接） | ✅ M0 已实现 |
| **本机模式** | 手机自己的 Termux | `127.0.0.1:8787` | ✅ M3 已实现（见下） |

### 本机模式（无需电脑）

引擎直接跑在手机的 Termux 里（Node + 引擎源码，`node:sqlite` 零原生依赖是关键前提）。
App 的「服务器」页有「本机模式」卡片：**安装教程**（内置指引）+ **一键填入本机地址**。

Termux 侧操作：

```bash
pkg install -y git
git clone https://github.com/wuzhuangzhishengji2026/zharness.git
bash zharness/scripts/termux-install.sh
# 之后再次启动: bash ~/zharness/scripts/termux-install.sh --serve
```

脚本做的事：`pkg install nodejs git python make clang` → 克隆仓库 → `npm install &&
npm run build` → `termux-wake-lock` → `node dist/src/cli.js serve --host 127.0.0.1 --port 8787`。
完成后 Termux 控制台显示配对码，App 内填入即可，全程无需电脑。

已知边界（设计文档 §7.1）：模型 API 配置在手机 `~/.zharness/` 独立存放；
锁屏后 Doze 可能冻结后台，长任务保持 Termux 前台或依赖其通知常驻；
gradle/cargo/docker 类重构建不适合手机。

## 功能（M0 + 本机模式）

- 扫码/粘贴 `zharness://pair?…` 或手动输入地址 + 一次性配对码完成配对
- 对话：流式回复、steer 插话、中止；系统分享「发给 ZHarness」直达输入框
- 时间线：事件日志的实时投影 + 断线重连后按 seq 增量补齐（`events.resync`）
- 模型/思考等级切换（凭据永远留在主机端，手机上只展示）
- 自动重连（指数退避）+ 心跳保活；设备 token 持久化，主机端可吊销

## 构建（已在 Windows + JDK17 实机验证通过）

Requirements：JDK 17、Android SDK（compileSdk 35，Gradle/AGP 会在首次构建时
自动下载缺失的 SDK 组件，前提是 licenses 已接受）。最快路径是 Android Studio
打开 `apps/android` 直接运行；命令行方式（已验证）：

```bash
# 1) 安装 Gradle 8.9（或任意 ≥8.7）到任意目录
curl -L -o gradle-8.9-bin.zip https://services.gradle.org/distributions/gradle-8.9-bin.zip
unzip gradle-8.9-bin.zip

# 2) 接受 SDK 许可证（CI/命令行环境必需）
mkdir -p ~/android-tools/sdk/licenses
printf "8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n" > ~/android-tools/sdk/licenses/android-sdk-license

# 3) 构建（首次会自动下载 platform-35 / build-tools / 依赖，约 10-20 分钟）
export JAVA_HOME="<jdk17-path>"
export ANDROID_HOME="$HOME/android-tools/sdk"
export GRADLE_USER_HOME="$HOME/android-tools/gradle-home"
$HOME/android-tools/gradle-8.9/bin/gradle -p apps/android :app:assembleDebug --no-daemon
# 产物: apps/android/app/build/outputs/apk/debug/app-debug.apk（约 17MB）
```

说明：

- `gradle.properties` 已含 `android.overridePathCheck=true`，中文路径可直接构建
  （AGP 在 Windows 上的历史限制，现代 AGP + UTF-8 环境实测正常）；
- 弱网下依赖下载可能超时，重跑同一命令会增量续传；或在 `gradle.properties`
  中取消注释 `systemProp.org.gradle.internal.http.socketTimeout` 两行；
- 工程根的 `local.properties`（sdk.dir）是本机文件，已被 .gitignore 忽略。

## 联调步骤

1. 主机端构建并启动桥接（需要 Node ≥ 22.5）：

   ```bash
   cd zharness
   npm install && npm run build
   node dist/src/cli.js serve            # 默认 0.0.0.0，随机端口
   # 或指定端口/工作目录:
   node dist/src/cli.js serve --port 8787 --host 0.0.0.0
   # 在目标工作区目录下运行，手机看到的就是那个工作区
   ```

   控制台输出（示例）：

   ```
   [serve]   ws url    : ws://<this-host>:8787/ws
   [serve]   pair uri  : zharness://pair?host=<lan-ip>&port=8787&code=511652
   [serve]   pairing code (valid 5 min, single use): 511652
   ```

2. 手机与主机在同一局域网（或 Tailscale 网内），App「服务器」页：
   - 直接粘贴 `zharness://pair?…` 链接（端口与配对码自动填充），或
   - 手动输入主机 IP + 端口 + 6 位配对码 → **配对并连接**。

3. 连接成功后底部出现「对话 / 时间线 / 服务器」三个标签。

> 桌面端浏览器访问 `http://<host>:<port>/pair` 也能看到当前配对码，方便复制。
> 配对码 5 分钟有效、单次使用；token 泄露时删除主机端
> `~/.zharness/serve/devices.json` 里对应设备即可吊销。

## 目录结构

```
app/src/main/java/com/zharness/mobile/
├── MainActivity.kt               # 单 Activity；处理分享与 zharness:// 链接
├── data/
│   ├── ServerStore.kt            # 服务器档案持久化（token 仅存本机）
│   ├── protocol/Protocol.kt      # RPC 帧模型 + 防御性解析（对齐 @zharness/protocol）
│   └── transport/ZHarnessClient.kt  # OkHttp WS、命令相关联、断线重连、PairingClient
└── ui/
    ├── AppViewModel.kt           # 全量 UI 状态；resync 游标与事件折叠
    ├── AppRoot.kt                # 底部 Tab 壳 + 工作区头部（模型选择/断开）
    └── screens/                  # Chat / Timeline / Servers 三屏
```

## 当前边界（诚实清单）

- M0 范围：不含本机引擎（Termux 模式，见设计文档 M3）、审批流通知（M2）、
  回放/分支树专属页面（桌面端与 Web 已有，手机后续补齐）
- 明文 `ws://` 仅限可信局域网；公网请走 WireGuard/反代，App 不做证书固定（M2 引入）
- 配对码二维码由主机端控制台以 URI 文本形式提供，扫码组件在 M2 接入
