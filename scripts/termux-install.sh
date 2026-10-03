#!/data/data/com.termux/files/usr/bin/bash
#
# ZHarness 本机模式安装脚本 —— 在 Termux 内运行。
#
# 用法（Termux 内）:
#   bash termux-install.sh            # 首次安装并启动
#   bash termux-install.sh --serve    # 跳过安装，直接启动引擎
#
# 完成后引擎监听 127.0.0.1:8787，打开 ZHarness App →「本机模式」
# → 填入 Termux 控制台显示的配对码即可。全程无需电脑。

set -euo pipefail

REPO_DIR="$HOME/zharness"
REPO_URL="https://github.com/wuzhuangzhishengji2026/zharness.git"
PORT="${ZHARNESS_PORT:-8787}"
HOST="127.0.0.1"

say() { printf '\n\033[1;32m[zarness]\033[0m %s\n' "$*"; }

# ---- 0. 前置检查 ------------------------------------------------------------

if ! command -v pkg >/dev/null 2>&1; then
	echo "请在 Termux 内运行本脚本（未找到 pkg）。从 F-Droid 安装 Termux。"
	exit 1
fi

if [ "${1:-}" != "--serve" ]; then
	# ---- 1. 系统依赖（node-pty 源码编译需要 python/make/clang） --------------
	say "安装系统依赖（nodejs / git / 编译工具链）..."
	pkg update -y
	# 全量升级必须先于 nodejs 安装：部分升级会让新 node 链接到旧 openssl，
	# 报 "CANNOT LINK EXECUTABLE node: cannot locate symbol OSSL_PROVIDER_..."
	pkg upgrade -y
	pkg install -y nodejs git python make clang binutils

	if ! node -v >/dev/null 2>&1; then
		echo "node 无法启动（多为 openssl 未随 node 一起升级）。"
		echo "请执行: pkg upgrade -y 然后重新运行本脚本。"
		exit 1
	fi
	NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
	NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
	say "Node 版本: $(node -v)"
	if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
		echo "引擎要求 Node >= 22.5，当前 Termux 源的 nodejs 过旧。请执行: pkg upgrade nodejs"
		exit 1
	fi

	# ---- 2. 代码 -------------------------------------------------------------
	if [ -d "$REPO_DIR/.git" ]; then
		say "更新已有仓库 $REPO_DIR ..."
		cd "$REPO_DIR" && git pull --ff-only || true
	else
		say "克隆仓库到 $REPO_DIR ..."
		git clone --depth 1 "$REPO_URL" "$REPO_DIR"
		cd "$REPO_DIR"
	fi

	# ---- 3. 依赖与构建 --------------------------------------------------------
	say "安装 npm 依赖（首次约 200-400MB，请保持网络与电量）..."
	npm install --no-audit --no-fund
	say "构建引擎..."
	npm run build
else
	cd "$REPO_DIR"
fi

# ---- 4. 启动 ----------------------------------------------------------------

say "获取 wake-lock（防止锁屏后引擎被冻结；用完后 termux-wake-unlock）"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

say "启动引擎（本机模式）: http://$HOST:$PORT"
cat <<EOF

=============================================================
 下一步（手机上操作，无需电脑）:
   1. 打开 ZHarness App → 「服务器」标签 → 「本机模式」
   2. 点「一键填入本机地址」(127.0.0.1:$PORT)
   3. 把下面这行配对码输入 App（5 分钟有效）

   注意: 本窗口保持前台或开启 Termux 通知常驻，
   否则安卓 Doze 可能冻结后台进程。
=============================================================
EOF

exec node dist/src/cli.js serve --host "$HOST" --port "$PORT"
