import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PxlKitSurfaceProvider } from "@pxlkit/ui-kit";
import Layout, { isMainChatCwd } from "@/components/Layout";
import HomeView from "@/views/HomeView";
import ChatView from "@/views/ChatView";
import SettingsView from "@/views/SettingsView";
import PluginsView from "@/views/PluginsView";
import AutomationView from "@/views/AutomationView";
import ReplayPage from "@/views/ReplayPage";
import { ExtensionUIDialog } from "@/components/ExtensionUIDialog";
import { ProactiveAssistantWidget } from "@/components/ProactiveAssistantWidget";
import { PetWidget } from "@/components/PetWidget";
import { refreshSkinFromAgent, subscribeSkinChanges } from "@/lib/skins";
import { subscribeSidecarExit, subscribeEvents, initSidecar, sendCommandAwait, listWorkspaces, restartSidecar, newSession, listAllSessions, type SidebarSessionInfo } from "@/lib/transport";
import { BrandIcon } from "@/components/BrandIcon";
import type { RpcSessionState, WorkspaceMeta } from "@/lib/types";

function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 浏览器端记住上次选择的项目（localStorage key）— 刷新后恢复,不再回退到 dev-bridge 默认工作区。 */
const LAST_WORKSPACE_KEY = "zharness.lastWorkspace";

function readLastWorkspace(): string | null {
	try {
		return localStorage.getItem(LAST_WORKSPACE_KEY);
	} catch {
		return null;
	}
}

function writeLastWorkspace(cwd: string): void {
	try {
		localStorage.setItem(LAST_WORKSPACE_KEY, cwd);
	} catch { /* storage 不可用时静默 */ }
}

function clearLastWorkspace(): void {
	try {
		localStorage.removeItem(LAST_WORKSPACE_KEY);
	} catch { /* storage 不可用时静默 */ }
}

function AppInner() {
	const navigate = useNavigate();
	const location = useLocation();
	const { t } = useTranslation();
	const [state, setState] = useState<RpcSessionState | null>(null);
	const [sidecarReady, setSidecarReady] = useState(false);
	const [sidecarExitCode, setSidecarExitCode] = useState<number | null>(null);
	const [workspace, setWorkspace] = useState<string | null>(null);
	const [waitingForWorkspace, setWaitingForWorkspace] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	// 正在切换到的目标工作区(切换完成/失败后清空)。侧边栏与对话页用它
	// 立即给出反馈(高亮目标行、对话区显示启动卡),而不是停留在旧内容上。
	const [switchingWorkspace, setSwitchingWorkspace] = useState<string | null>(null);
	// 进行中的切换 Promise,按目标 cwd去重:同一目标的重复点击只等第一次,
	// 后续调用者(看板「开始任务」、新建对话)await 它,保证后续 newSession /
	// prompt 发到的是切换完成后的 sidecar。
	const switchPromiseRef = useRef<Map<string, Promise<void>>>(new Map());
	// 切换序号:并发发起的切换只有最新一次允许落地,旧请求(冷启动慢)完成时
	// 直接丢弃结果,避免旧工作区的 init 覆盖刚切过去的状态(last click wins)。
	const switchSeqRef = useRef(0);
	// 当前胜出的切换目标(normalize 后的 cwd):被丢弃的慢切换需要知道把
	// bridge 的 active 指针拨回哪里(见 startWithWorkspace 的 isStale 分支)。
	const lastSwitchTargetRef = useRef<string | null>(null);
	// 查看中的历史会话(侧栏旧行点击进入)。null = 跟随当前活跃对话。
	// 查看是只读的(后端读该会话自己的库);ChatView 在其中发消息时才
	// jump 切回该对话原地续写。
	const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
	// 首页看板固定读写主对话工作区(应用级页面,不随会话工作区切换)。
	const [boardWorkspaceId, setBoardWorkspaceId] = useState<string | null>(null);
	const [streamingCwds, setStreamingCwds] = useState<Set<string>>(new Set());
	const sidecarStartedRef = useRef(false);
	// Auto-restart bookkeeping: per-cwd restart count, reset to 0 when a
	// sidecar becomes ready. Capped at 3 attempts with exponential backoff
	// to avoid crash loops.
	const restartCountRef = useRef(0);
	const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshWorkspaces = useCallback(async () => {
		try {
			const list = await listWorkspaces();
			// Filter out the Chat workspace (~/.zharness/main) — it's shown separately as Chat.
			// 注意用 isMainChatCwd:Windows 反斜杠路径下 endsWith("/.zharness/main") 匹配不到。
			setWorkspaces(list.filter((ws) => !isMainChatCwd(ws.cwd)));
			// 被过滤掉的主对话工作区即为看板的家。
			setBoardWorkspaceId(list.find((ws) => isMainChatCwd(ws.cwd))?.workspace_id ?? null);
		} catch (e) {
			console.error("[workspaces] list error:", e);
		}
	}, []);

	useEffect(() => {
		refreshWorkspaces();
	}, [refreshWorkspaces]);

	// 重启当前工作区的 sidecar 并用新进程的首个 get_state 刷新界面状态。
	// restart_sidecar (Rust) 返回完整的 JSON-RPC 响应包 `{id, type, command,
	// success, data: {...}}`——需要解出 `.data` 再喂给 `state`,否则 state.model
	// 一直是 undefined。解析失败时靠 sidecar 自己的 MODEL_CHANGED 事件兜底。
	const restartCurrentSidecar = useCallback(async () => {
		if (!workspace) return;
		const newStateJson = await restartSidecar(workspace);
		try {
			const parsed = JSON.parse(newStateJson);
			const data = parsed?.data ?? parsed;
			if (data && typeof data === "object" && Object.keys(data).length > 0) {
				setState(data as unknown as RpcSessionState);
			}
		} catch {
			// Best-effort: if parsing fails, the sidecar's own MODEL_CHANGED
			// event will still propagate a fresh state via subscribeEvents → get_state.
		}
	}, [workspace]);

	const [initError, setInitError] = useState<string | null>(null);
	const startWithWorkspace = useCallback(async (cwd?: string) => {
		const seq = ++switchSeqRef.current;
		const isStale = () => seq !== switchSeqRef.current;
		setWaitingForWorkspace(true);
		setInitError(null);
		// 所有工作区激活都走这个入口(侧栏点击/新建工作区/重启恢复):
		// 旧工作区里查看中的会话 id 对新 sidecar 毫无意义,留着它会让
		// ChatView 误以为仍在「查看」,把时间线/发送全部路由到一个
		// 不存在的会话上报 Session not found。
		setViewingSessionId(null);
		try {
			// Canonicalize BEFORE init: expand ~ and unify Windows separators
			// to the backslash-native form. The same string must key the Rust
			// sidecar map, the `_cwd` event tags and our `workspace` state —
			// mixed forms (our own ~ expansion vs meta.json backslash paths)
			// used to spawn a SECOND sidecar for ~/.zharness/main without
			// --main, whose scheduler engine then had no "main" scope, so
			// main-conversation tasks failed run-now with "belongs to another
			// project (or main)".
			let canonical = cwd;
			if (cwd && cwd.startsWith("~") && isTauri()) {
				try {
					const { homeDir } = await import("@tauri-apps/api/path");
					const home = await homeDir();
					canonical = cwd.replace("~", home);
				} catch { /* keep ~ */ }
			}
			if (canonical && /^[A-Za-z]:[\\/]/.test(canonical)) {
				canonical = canonical.replace(/\//g, "\\");
			}
			lastSwitchTargetRef.current = canonical ?? null;
			const initialState = await initSidecar(canonical);
			// 已有更新的切换请求:丢弃本次结果(冷启动的慢请求不得覆盖新状态)。
			// 但 bridge 的 active 指针以最后一次 init_sidecar 调用为准 —— 若被
			// 丢弃的慢切换晚于新切换落地,窗口的命令会路由到废弃的 sidecar,
			// 前端状态(新工作区)与实际路由(旧 sidecar)永久失同步:消息发进
			// 另一个工作区,回复事件按 _cwd 过滤后全部不可见。这里立刻用当前
			// 胜出者重新握手,把 bridge 指针拨回来。
			if (isStale()) {
				void initSidecar(lastSwitchTargetRef.current ?? undefined).catch(() => {
					/* best-effort:下一次切换会再纠正 */
				});
				return;
			}
			if (canonical) setWorkspace(canonical);
			// If we got a non-empty state, it's a freshly spawned sidecar.
			// If empty, the sidecar was already running — state will arrive via rpc_response event.
			const hasState = initialState && Object.keys(initialState).length > 0;
			if (hasState) {
				setState(initialState as unknown as RpcSessionState);
			}
			setSidecarReady(true);
			// 浏览器端记住显式选择的项目,下次启动直接恢复(对齐桌面端的连续体验)。
			if (!isTauri() && canonical) writeLastWorkspace(canonical);
			// For already-running sidecar, request state explicitly.
			if (!hasState) {
				void sendCommandAwait<RpcSessionState>({ type: "get_state" })
					.then((r) => setState(r.data ?? null))
					.catch(() => {});
			}
			refreshWorkspaces();
		} catch (e) {
			if (isStale()) return;
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[init] FAILED:", msg);
			setInitError(msg);
			// If the directory doesn't exist, refresh workspaces so the stale
			// entry can be cleaned up by the user.
			if (msg.includes("does not exist")) {
				refreshWorkspaces();
			}
			// 记忆的项目目录已失效(移动/删除):清除记忆并回退默认工作区,
			// 避免每次启动都撞上同一个坏路径。cwd 为空时不再递归。
			if (!isTauri() && cwd) {
				clearLastWorkspace();
				return startWithWorkspace();
			}
		} finally {
			if (!isStale()) setWaitingForWorkspace(false);
		}
	}, [refreshWorkspaces]);

	useEffect(() => {
		if (sidecarStartedRef.current) return;
		sidecarStartedRef.current = true;
		if (isTauri()) {
			// In Tauri: auto-start with Chat (persistent agent at ~/.zharness/main)
			startWithWorkspace("~/.zharness/main");
		} else {
			// Browser: auto-init with dev bridge
			startWithWorkspace();
		}
	}, [startWithWorkspace]);

	const handleNewWorkspace = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const dialog = await import("@tauri-apps/plugin-dialog");
			const selected = await dialog.open({ directory: true, multiple: false, title: t("layout.selectProjectDirectory") });
			if (typeof selected === "string") {
				await startWithWorkspace(selected);
			}
		} catch (e) {
			console.error("[workspace] dialog error:", e);
		}
	}, [startWithWorkspace, t]);

	const handleSelectWorkspace = useCallback(async (cwd: string) => {
		// 始终先跳回对话页:之前「已是当前工作区」的 early return 挡在 navigate
		// 之前,从任务看板/设置页点当前项目会被整个吞掉,看起来像点了没反应。
		navigate("/chat");
		// 工作区切换默认回到该区当前活跃对话;点击会话子行的调用方会在切换
		// 完成后再设置查看目标。
		setViewingSessionId(null);
		// 同一目标的切换已在进行中:直接等它完成(保证调用方后续的 newSession /
		// prompt 落在切换完成后的 sidecar 上),不再重复发起。
		const inFlight = switchPromiseRef.current.get(cwd);
		if (inFlight) {
			await inFlight;
			return;
		}
		if (workspace === cwd && sidecarReady) return;
		const p = (async () => {
			setSwitchingWorkspace(cwd);
			try {
				await startWithWorkspace(cwd);
			} finally {
				switchPromiseRef.current.delete(cwd);
				setSwitchingWorkspace((prev) => (prev === cwd ? null : prev));
			}
		})();
		switchPromiseRef.current.set(cwd, p);
		await p;
	}, [workspace, sidecarReady, startWithWorkspace, navigate]);

	/** 侧边栏「新建对话」:进入主对话工作区并开启全新会话(对齐输入框 + 菜单的「新会话」)。 */
	const handleNewChat = useCallback(async () => {
		navigate("/chat");
		await handleSelectWorkspace("~/.zharness/main");
		await newSession();
	}, [handleSelectWorkspace, navigate]);

	/**
	 * 看板「开始任务」:切到目标项目 → 新会话 → 按所选研发流程发出任务 prompt。
	 * 看板状态由 HomeView 自行落盘;这里只负责让对应项目真正跑起来。
	 */
	const handleStartTask = useCallback(
		async (input: { title: string; zentaoId?: string; flow: "full" | "issue"; projectCwd: string }) => {
			navigate("/chat");
			await handleSelectWorkspace(input.projectCwd);
			await newSession();
			const header =
				input.flow === "full"
					? "【全流程研发助手】请按照 需求分析 → 方案设计 → 代码实现 → 安全审计 → 接口测试 的完整研发流程，完成以下任务："
					: "【问题分析助手】请分析定位以下问题，给出根因分析与修复方案：";
			const message = `${header}\n${input.title}${input.zentaoId ? `（禅道 #${input.zentaoId}）` : ""}`;
			void sendCommandAwait({ type: "prompt", message }, 600000).catch((e) => {
				console.error("[task] start task prompt failed:", e);
			});
		},
		[handleSelectWorkspace, navigate],
	);

	const handleDeleteWorkspace = useCallback((workspaceId: string) => {
		setWorkspaces((prev) => prev.filter((ws) => ws.workspace_id !== workspaceId));
	}, []);

	/**
	 * SOP 市场「运行」:跳回当前工作区对话页,开新会话并发送 /sop run。
	 * 工作流是独立交付物,不混入当前对话(与看板「开始任务」同模式);
	 * /sop 命令由 sop-market 内置扩展消费,渲染后的编排提示词以
	 * 用户消息进入会话,由模型按步骤执行。
	 */
	const handleRunSop = useCallback(
		async (slug: string) => {
			navigate("/chat");
			if (!workspace) return;
			// 正在只读查看别的会话时先退出,否则 prompt 落在活跃会话、界面却停在查看页。
			setViewingSessionId(null);
			await newSession();
			void sendCommandAwait({ type: "prompt", message: `/sop run ${slug}` }, 600000).catch((e) => {
				console.error("[sop] run prompt failed:", e);
			});
		},
		[workspace, navigate],
	);

	/** 侧栏会话子行:切到所属工作区(sidecar 就绪)后【查看】该对话。
	 *
	 * 查看是只读的:后端读该会话自己的事件库返回对话全链,不切换活跃位、
	 * 不产生任何 fork —— 重启/切走都不会污染会话指针。用户在查看中
	 * 发消息时,ChatView 才调 history_tree jump 原地续写。
	 */
	const handleSelectSession = useCallback(async (cwd: string, sessionId: string) => {
		navigate("/chat");
		await handleSelectWorkspace(cwd);
		setViewingSessionId(sessionId);
	}, [handleSelectWorkspace, navigate]);

	/**
	 * 退出查看模式 —— 必须是稳定引用(useCallback)。
	 *
	 * ChatView 的事件订阅 effect 依赖 handleEvent,而 handleEvent 引用了
	 * onExitViewing:一个每次渲染都新建的内联箭头函数会让订阅在每次 App
	 * 状态更新(get_state/streamingCwds/侧栏刷新)时拆掉重挂。Tauri 的
	 * listen/unlisten 高频翻转可能静默失败(transport 里 catch 掉了),
	 * 一旦失败 ChatView 永久失聪 —— 后端回合正常跑完、回复落库,界面却
	 * 什么都不显示(「发了消息没有任何回复」的根因之一)。
	 */
	const handleExitViewing = useCallback(() => setViewingSessionId(null), []);
	/** 侧边栏项目行「+」:切到该项目工作区并开启全新会话。 */
	const handleNewSessionInWorkspace = useCallback(async (cwd: string) => {
		navigate("/chat");
		setViewingSessionId(null);
		await handleSelectWorkspace(cwd);
		await newSession();
	}, [handleSelectWorkspace, navigate]);

	// Refresh the session state from the sidecar. Used after settings that
	// don't emit a dedicated event (e.g. toggling safe mode) so the root
	// state stays in sync for components that read from it.
	const refreshState = useCallback(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
			.then((r) => setState(r.data ?? null))
			.catch(() => {});
	}, [sidecarReady]);

	useEffect(() => {
		if (!sidecarReady) return;
		let cancelled = false;
		const unlisteners: Array<() => void> = [];
		(async () => {
			const un1 = await subscribeSidecarExit((code, cwd) => {
				// Only mark as not ready if the exited sidecar was the active one.
				if (!cwd || cwd === workspace) {
					setSidecarExitCode(code);
					setSidecarReady(false);
					// Auto-restart with exponential backoff (max 3 attempts).
					// The count is reset to 0 whenever a sidecar becomes ready,
					// so a fresh crash after a healthy run still gets 3 retries.
					const cwdToRestart = workspace;
					if (cwdToRestart && restartCountRef.current < 3) {
						restartCountRef.current += 1;
						const attempt = restartCountRef.current;
						const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
						console.warn(`[sidecar] exited (code=${code}), auto-restart attempt ${attempt}/3 in ${delay}ms`);
						if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
						restartTimerRef.current = setTimeout(() => {
							restartTimerRef.current = null;
							// Guard against the user having switched workspaces in the meantime.
							setWorkspace((current) => {
								if (current === cwdToRestart) {
									void startWithWorkspace(cwdToRestart);
								}
								return current;
							});
						}, delay);
					} else if (cwdToRestart) {
						console.warn(`[sidecar] exited, giving up auto-restart after 3 attempts`);
					}
				}
			});
			if (cancelled) { un1(); return; }
			unlisteners.push(un1);
			const un2 = await subscribeEvents((event) => {
				const typed = event as { type: string; _cwd?: string };
				// Track per-workspace streaming state for ALL workspaces
				// so the sidebar can show blinking indicators even for
				// non-active workspaces.
				if (typed._cwd && (typed.type === "AGENT_TURN_START" || typed.type === "AGENT_TURN_COMPLETED")) {
					setStreamingCwds((prev) => {
						const next = new Set(prev);
						if (typed.type === "AGENT_TURN_START") {
							next.add(typed._cwd!);
						} else {
							next.delete(typed._cwd!);
						}
						return next;
					});
				}
				// Only process state updates for the active workspace.
				if (typed._cwd && typed._cwd !== workspace) return;
				// Refresh state on model/thinking changes, and when the agent
				// turn starts (isStreaming → true) or completes (isStreaming → false).
				// Skip intermediate AGENT_TURN_END/REQUESTED during multi-tool turns
				// to avoid flooding get_state requests that time out.
				if (typed.type === "MODEL_CHANGED" || typed.type === "THINKING_LEVEL_CHANGED" || typed.type === "AGENT_TURN_COMPLETED" || typed.type === "AGENT_TURN_START") {
					void sendCommandAwait<RpcSessionState>({ type: "get_state" }, 5000)
						.then((r) => setState(r.data ?? null))
						.catch(() => {});
				}
			});
			if (cancelled) { un2(); return; }
			unlisteners.push(un2);
		})();
		return () => {
			cancelled = true;
			unlisteners.forEach((fn) => fn());
		};
	}, [sidecarReady, workspace, startWithWorkspace]);

	// Reset the auto-restart counter once a sidecar is healthy, and clean up
	// any pending restart timer on unmount.
	useEffect(() => {
		if (sidecarReady) {
			restartCountRef.current = 0;
		}
	}, [sidecarReady]);

	// 换肤插件：sidecar 就绪后与扩展对账上妆（开机时 index.html 内联脚本已用
	// localStorage 缓存先行上妆，这里修正遮罩/模糊等参数），并订阅皮肤变更。
	useEffect(() => {
		if (!sidecarReady) return;
		void refreshSkinFromAgent().catch(() => {});
		return subscribeSkinChanges(() => {
			void refreshSkinFromAgent().catch(() => {});
		});
	}, [sidecarReady, workspace]);

	useEffect(() => {
		return () => {
			if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
		};
	}, []);

	useEffect(() => {
		if (!sidecarReady) return;
		void sendCommandAwait<RpcSessionState>({ type: "get_state" })
			.then((r) => setState(r.data ?? null))
			.catch(() => {});
		// Delayed re-fetch: the sidecar may emit MODEL_CHANGED before our
		// event listener is registered, leaving state.model stale. This
		// catches any missed events shortly after sidecar ready / workspace switch.
		const timer = setTimeout(() => {
			void sendCommandAwait<RpcSessionState>({ type: "get_state" })
				.then((r) => setState(r.data ?? null))
				.catch(() => {});
		}, 800);
		return () => clearTimeout(timer);
	}, [sidecarReady, workspace]);

	// ---- Sidebar session mapping: sessions grouped under their workspace ----
	const [sidebarSessions, setSidebarSessions] = useState<SidebarSessionInfo[]>([]);
	const sidebarSessionsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const refreshSidebarSessions = useCallback(async () => {
		try {
			setSidebarSessions(await listAllSessions());
		} catch {
			// 侧栏降级:只显示工作区行,不显示会话子行。
		}
	}, []);

	useEffect(() => {
		void refreshSidebarSessions();
	}, [refreshSidebarSessions, workspace, sidecarReady]);

	// 会话结构变化(新建/fork/跳转)或一轮对话结束后防抖刷新——新会话的标题
	// 来自首条用户消息,得等事件落库后才能枚举到。
	useEffect(() => {
		if (!sidecarReady) return;
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void subscribeEvents((event) => {
			const type = (event as { type?: string }).type;
			if (
				type === "SESSION_CREATED" || type === "SESSION_FORKED" ||
				type === "SESSION_JUMPED" || type === "AGENT_TURN_COMPLETED" ||
				// 定时任务触发(可能在别的窗口/sidecar 执行):「每次新会话」会
				// 产生新会话、pinned 会话有新消息,任务完成事件一到就刷新侧栏。
				type === "SCHEDULED_TASK_FIRED" || type === "SCHEDULED_TASK_COMPLETED"
			) {
				if (sidebarSessionsTimer.current) clearTimeout(sidebarSessionsTimer.current);
				sidebarSessionsTimer.current = setTimeout(() => {
					sidebarSessionsTimer.current = null;
					void refreshSidebarSessions();
				}, 1500);
			}
		}).then((fn) => {
			if (cancelled) {
				try { fn(); } catch { /* registry gone */ }
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			if (sidebarSessionsTimer.current) clearTimeout(sidebarSessionsTimer.current);
			try { unlisten?.(); } catch { /* registry gone */ }
		};
	}, [sidecarReady, refreshSidebarSessions]);

	useEffect(() => () => {
		if (sidebarSessionsTimer.current) clearTimeout(sidebarSessionsTimer.current);
	}, []);

	// First-run / unconfigured-key detection: when the sidecar comes up but
	// `state.model` is undefined, no provider has an API key configured yet.
	// Redirect the user into a setup-mode Settings page instead of dumping
	// them into an empty chat they can't actually use.
	useEffect(() => {
		if (!sidecarReady) return;
		if (!state) return;
		if (state.model !== undefined) return;
		// Only redirect once per workspace, and only if the user isn't
		// already on the setup settings page (avoid stealing the back button).
		// Read the path off `window` rather than `useLocation` on purpose: we
		// deliberately do NOT want this effect re-running on every navigation,
		// otherwise an unconfigured user gets yanked back here the moment they
		// try to visit /plugins or anywhere else.
		if (!window.location.pathname.startsWith("/settings")) {
			navigate("/settings?setup=true", { replace: true });
		}
	}, [sidecarReady, state, navigate]);

	// After the user configures a key, the sidecar is restarted and a new
	// state arrives with `state.model !== undefined`. Pull them back out of
	// the setup-mode Settings page automatically. Doing it here (rather
	// than inside SettingsView.handleConfigured) avoids a race where the
	// local `setState` hasn't propagated before navigate fires, which
	// would let the redirect-above re-trigger and bounce them back.
	useEffect(() => {
		if (!state || state.model === undefined) return;
		if (!location.pathname.startsWith("/settings")) return;
		if (new URLSearchParams(location.search).get("setup") !== "true") return;
		navigate("/chat", { replace: true });
	}, [state, navigate, location.pathname, location.search]);

	if (initError) {
		return (
			<PxlKitSurfaceProvider surface="pixel">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
						<BrandIcon size={48} className="text-danger" />
						<p className="font-mono text-sm text-fg">{t("chat.failedToStartWorkspace")}</p>
						<p className="font-mono text-xs text-muted">{initError}</p>
						<button
							type="button"
							onClick={() => {
								setInitError(null);
								startWithWorkspace("~/.zharness/main");
							}}
							className="mt-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-fg transition-colors hover:bg-surface-2/80"
						>
							{t("common.backToChat")}
						</button>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	if (waitingForWorkspace && !sidecarReady) {
		return (
			<PxlKitSurfaceProvider surface="pixel">
				<div className="flex h-screen items-center justify-center bg-bg">
					<div className="flex flex-col items-center gap-4">
						<BrandIcon size={48} className="text-accent" />
						<p className="font-mono text-sm text-muted">{t("common.starting")}</p>
					</div>
				</div>
			</PxlKitSurfaceProvider>
		);
	}

	return (
		<PxlKitSurfaceProvider surface="pixel">
			<ExtensionUIDialog workspace={workspace} />
			<ProactiveAssistantWidget workspace={workspace} sidecarReady={sidecarReady} />
			<PetWidget workspace={workspace} sidecarReady={sidecarReady} />
			<Routes>
					<Route
						element={
						<Layout
								state={state}
								sidecarReady={sidecarReady}
								sidecarExitCode={sidecarExitCode}
								workspace={workspace}
								workspaces={workspaces}
								sessions={sidebarSessions}
								viewingSessionId={viewingSessionId}
								streamingCwds={streamingCwds}
								switchingWorkspace={switchingWorkspace}
								onSelectWorkspace={handleSelectWorkspace}
								onSelectSession={handleSelectSession}
								onNewSessionInWorkspace={handleNewSessionInWorkspace}
						onNewWorkspace={handleNewWorkspace}
						onNewChat={handleNewChat}
					onDeleteWorkspace={handleDeleteWorkspace}
							/>
						}
					>
						{/* 任务看板先隐藏:入口已从侧栏移除,页面保留在 /board 以便恢复 */}
						<Route index element={<Navigate to="/chat" replace />} />
						<Route path="/board" element={<HomeView workspace={workspace} sidecarReady={sidecarReady} workspaces={workspaces} boardWorkspaceId={boardWorkspaceId} onStartTask={handleStartTask} />} />
					<Route
						path="/chat"
						element={
							<ChatView
								state={state}
								sidecarReady={sidecarReady}
								sidecarExitCode={sidecarExitCode}
								workspace={workspace}
								switchingWorkspace={switchingWorkspace}
								viewingSessionId={viewingSessionId}
								onExitViewing={handleExitViewing}
								onRefreshState={refreshState}
							/>
						}
					/>
						<Route path="/settings" element={
							<SettingsView
								state={state}
								onRestartSidecar={restartCurrentSidecar}
							/>
						} />
						<Route path="/config" element={<PluginsView onRestartSidecar={restartCurrentSidecar} onRunSop={handleRunSop} />} />
					<Route path="/tasks" element={<AutomationView workspace={workspace} onOpenSession={handleSelectSession} />} />
				<Route path="/replay" element={<ReplayPage currentSessionId={state?.sessionId ?? null} sidecarReady={sidecarReady} />} />
					<Route path="/plugins" element={<Navigate to="/config" replace />} />
					<Route path="*" element={<Navigate to="/chat" replace />} />
					</Route>
			</Routes>
		</PxlKitSurfaceProvider>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppInner />
		</BrowserRouter>
	);
}
