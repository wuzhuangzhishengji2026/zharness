package com.zharness.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zharness.mobile.data.FileMirror
import com.zharness.mobile.data.ServerStore
import com.zharness.mobile.data.protocol.ChatMessage
import com.zharness.mobile.data.protocol.HistoryNode
import com.zharness.mobile.data.protocol.ModelInfoDto
import com.zharness.mobile.data.protocol.NamedEntry
import com.zharness.mobile.data.protocol.PendingApproval
import com.zharness.mobile.data.protocol.PetInfo
import com.zharness.mobile.data.protocol.Protocol
import com.zharness.mobile.data.protocol.ScheduleTask
import com.zharness.mobile.data.protocol.ServerProfile
import com.zharness.mobile.data.protocol.SessionSummary
import com.zharness.mobile.data.protocol.SkinInfo
import com.zharness.mobile.data.protocol.TimelineEvent
import com.zharness.mobile.data.transport.PairingClient
import com.zharness.mobile.data.transport.ZHarnessClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * One screen of state shared by all tabs. Every mutation goes through
 * [_ui.update]; server frames arrive on the transport flow and are folded in
 * here — the UI itself is a pure projection of this state.
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {

	private val store = ServerStore(application)
	private val mirror = FileMirror(application)
	private val okHttp = OkHttpClient.Builder()
		.pingInterval(20, TimeUnit.SECONDS)
		.connectTimeout(10, TimeUnit.SECONDS)
		.build()
	private val client = ZHarnessClient(okHttp, viewModelScope)

	data class UiState(
		val profiles: List<ServerProfile> = emptyList(),
		val activeProfile: ServerProfile? = null,
		val connected: Boolean = false,
		val connecting: Boolean = false,
		val workspaceName: String? = null,
		val messages: List<ChatMessage> = emptyList(),
		val streamText: String = "",
		val isStreaming: Boolean = false,
		val events: List<TimelineEvent> = emptyList(),
		val sessions: List<SessionSummary> = emptyList(),
		val models: List<ModelInfoDto> = emptyList(),
		val currentModel: String? = null,
		val thinkingLevel: String? = null,
		val busy: String? = null,
		val error: String? = null,
		val pendingShare: String? = null,
		val pendingPairUri: String? = null,
		val selectedTab: Tab = Tab.CHAT,
		// ── Approval flow (safe mode) ──
		val pendingApprovals: List<PendingApproval> = emptyList(),
		val safeMode: Boolean = false,
		// ── Toolbox: scheduled tasks / skills / sops / extensions / skins / pet ──
		val schedules: List<ScheduleTask> = emptyList(),
		val skills: List<NamedEntry> = emptyList(),
		val sops: List<NamedEntry> = emptyList(),
		val extensions: List<NamedEntry> = emptyList(),
		val skins: List<SkinInfo> = emptyList(),
		val pet: PetInfo? = null,
		// ── Sessions & branches ──
		val history: List<HistoryNode> = emptyList(),
		// ── Replay ──
		val replaySessions: List<NamedEntry> = emptyList(),
		val replayEvents: List<TimelineEvent> = emptyList(),
		val replayIndex: Int = -1,
		val replayPlaying: Boolean = false,
		// ── Composer attachments ──
		val attachedImages: List<Pair<String, String>> = emptyList(), // base64 to mimeType
	)

	private val _ui = MutableStateFlow(UiState(profiles = store.load()))
	val ui: StateFlow<UiState> = _ui.asStateFlow()

	/** Monotonic event-log cursor for incremental resync (design §06). */
	private var cursor: Long = 0
	private var replayJob: Job? = null
	private var mirrorDirty = false

	init {
		// Offline-first: restore the last mirror so history is browsable
		// before (or without) a connection; resync heals it afterwards.
		mirror.load()?.let { snapshot ->
			_ui.update {
				it.copy(messages = snapshot.messages, events = snapshot.events)
			}
		}
		viewModelScope.launch {
			client.frames.collect { frame -> handleFrame(frame) }
		}
		viewModelScope.launch {
			client.state.collect { state ->
				_ui.update {
					it.copy(
						connected = state == ZHarnessClient.ConnState.CONNECTED,
						connecting = state == ZHarnessClient.ConnState.CONNECTING,
					)
				}
				if (state == ZHarnessClient.ConnState.CONNECTED) {
					refreshAll()
				}
			}
		}
		viewModelScope.launch {
			// Debounced mirror persistence — best-effort offline snapshot.
			while (isActive) {
				delay(4000)
				if (mirrorDirty) {
					mirrorDirty = false
					val state = _ui.value
					mirror.save(state.messages, state.events)
				}
			}
		}
	}

	// ---- Frame handling ------------------------------------------------------

	private suspend fun handleFrame(frame: JsonObject) {
		when (Protocol.str(frame, "type")) {
			"hello" -> {
				val workspace = Protocol.str(frame, "workspace")
				_ui.update { it.copy(workspaceName = workspace ?: it.workspaceName) }
			}
			"event" -> handleEvent(Protocol.obj(frame["event"]) ?: return)
			// responses are consumed by command(); other frames are ignored.
		}
	}

	private fun handleEvent(event: JsonObject) {
		val type = Protocol.str(event, "type") ?: return
		val sequence = Protocol.long(event, "sequence")

		// Engine-side failures must never vanish silently: surface them as a
		// banner (e.g. "no API key configured" when prompting an unconfigured
		// provider — the classic local-mode first-run case).
		if (type in ERROR_EVENTS) {
			val payload = Protocol.obj(event["payload"])
			val detail = Protocol.str(payload, "message")
				?: Protocol.str(payload, "error")
				?: Protocol.str(payload, "text")
				?: Protocol.eventSummary(event["payload"])
			_ui.update { it.copy(error = "引擎报错（$type）: ${detail.take(200)}") }
		}

		// Safe-mode approval requests pause the tool call until the user
		// resolves them via approve/reject.
		if (type == "INTENT_TOOL_CALL") {
			Protocol.parsePendingApproval(event)?.let { approval ->
				_ui.update { state ->
					if (state.pendingApprovals.any { it.eventId == approval.eventId }) state
					else state.copy(pendingApprovals = state.pendingApprovals + approval)
				}
			}
		}
		if (type == "TOOL_EXECUTION_START" || type == "TOOL_EXECUTION_END") {
			// A resolved approval no longer needs the card.
			_ui.update { state ->
				val causedBy = Protocol.str(event, "caused_by")
				state.copy(
					pendingApprovals = state.pendingApprovals.filterNot { approval ->
						approval.eventId == causedBy
					},
				)
			}
		}

		val timelineEvent = TimelineEvent(
			sequence = sequence,
			type = type,
			summary = Protocol.eventSummary(event["payload"]),
			timestamp = Protocol.long(event, "timestamp"),
			eventId = Protocol.str(event, "event_id"),
		)
		if (sequence != null && sequence > cursor) cursor = sequence

		_ui.update { state ->
			// A live event may duplicate one already pulled by resync.
			val duplicated = timelineEvent.eventId != null &&
				state.events.any { it.eventId == timelineEvent.eventId }
			if (duplicated) {
				state
			} else {
				val trimmed = if (state.events.size >= MAX_BUFFERED_EVENTS) state.events.drop(500) else state.events
				state.copy(events = trimmed + timelineEvent)
			}
		}
		mirrorDirty = true

		// Streaming assistant text is folded into a live bubble; final
		// messages come from a get_messages refresh at turn boundaries.
		if (type == "AGENT_MESSAGE_CHUNK") {
			val payload = Protocol.obj(event["payload"])
			val delta = Protocol.str(payload, "text")
				?: Protocol.str(payload, "delta")
				?: Protocol.str(payload, "content")
			if (!delta.isNullOrEmpty()) {
				_ui.update { it.copy(streamText = it.streamText + delta, isStreaming = true) }
			}
		}

		if (type in REFRESH_ON) {
			viewModelScope.launch { refreshMessages() }
			if (type == "AGENT_MESSAGE_END") _ui.update { it.copy(streamText = "") }
		}
		if (type == "AGENT_TURN_START") _ui.update { it.copy(isStreaming = true) }
		if (type == "AGENT_TURN_END") _ui.update { it.copy(isStreaming = false, streamText = "") }
	}

	// ---- Connection lifecycle -------------------------------------------------

	fun connect(profile: ServerProfile) {
		cursor = 0
		_ui.update {
			it.copy(
				activeProfile = profile,
				messages = emptyList(),
				events = emptyList(),
				streamText = "",
				error = null,
				profiles = store.upsert(profile),
			)
		}
		client.connect(profile)
	}

	fun disconnect() {
		client.disconnect()
		_ui.update { it.copy(activeProfile = null, connected = false, workspaceName = null, sessions = emptyList()) }
	}

	/**
	 * Pair with a server using a one-time code, then connect.
	 * [input] accepts either a `zharness://pair?host=…&port=…&code=…` URI or a
	 * bare host; [portText] is ignored when the URI carries the port.
	 */
	fun pairAndConnect(input: String, portText: String, code: String, deviceName: String) {
		val parsed = parseServerInput(input, portText)
		if (parsed == null) {
			_ui.update {
				val existing = it.error
				it.copy(error = existing ?: "无法解析地址：地址框填电脑的局域网 IP（如 192.168.1.10）或 192.168.1.10:8787，或粘贴 zharness://pair 链接")
			}
			return
		}
		if (code.isBlank()) {
			_ui.update { it.copy(error = "请输入配对码（zharness serve 控制台输出）") }
			return
		}
		val (host, port) = parsed
		_ui.update { it.copy(busy = "配对中…", error = null) }
		viewModelScope.launch {
			try {
				val token = PairingClient.pair(okHttp, host, port, code.trim(), deviceName.ifBlank { "android" })
				val profile = ServerProfile(
					id = ServerStore.newId(),
					name = "zharness@$host",
					host = host,
					port = port,
					token = token,
				)
				_ui.update { it.copy(busy = null) }
				connect(profile)
			} catch (error: Exception) {
				_ui.update { it.copy(busy = null, error = error.message ?: "配对失败") }
			}
		}
	}

	/** Parse a zharness://pair URI or "host" / "host:port" into host+port. */
	private fun parseServerInput(input: String, portText: String): Pair<String, Int>? {
		val trimmed = input.trim()
		if (trimmed.isEmpty()) return null
		if (trimmed.contains("<lan-ip>")) {
			// Old servers printed a placeholder instead of the real LAN IP.
			_ui.update {
				it.copy(error = "链接里的 host 是占位符 <lan-ip>：在电脑上运行 ipconfig 查看 IPv4 地址（形如 192.168.x.x），手动填入地址框；端口与配对码保持不变")
			}
			return null
		}
		if (trimmed.startsWith("zharness://")) {
			return runCatching {
				val uri = android.net.Uri.parse(trimmed)
				val host = uri.getQueryParameter("host") ?: return null
				val port = uri.getQueryParameter("port")?.toIntOrNull() ?: return null
				host to port
			}.getOrNull()
		}
		val fromInline = trimmed.contains(":")
		val host = if (fromInline) trimmed.substringBeforeLast(":") else trimmed
		val port = if (fromInline) trimmed.substringAfterLast(":").toIntOrNull() else portText.toIntOrNull()
		if (host.isBlank() || port == null || port !in 1..65535) return null
		return host to port
	}

	/** Pre-fill the pairing form from a zharness://pair link (app link / share). */
	fun setPendingPairUri(uri: String) {
		_ui.update { it.copy(pendingPairUri = uri) }
	}

	fun consumePendingPairUri() {
		_ui.update { it.copy(pendingPairUri = null) }
	}

	/** Text received via the system share sheet ("share to agent"). */
	fun setPendingShare(text: String) {
		_ui.update { it.copy(pendingShare = text) }
	}

	fun consumePendingShare() {
		_ui.update { it.copy(pendingShare = null) }
	}

	fun dismissError() {
		_ui.update { it.copy(error = null) }
	}

	fun selectTab(tab: Tab) {
		_ui.update { it.copy(selectedTab = tab) }
	}

	fun deleteProfile(profileId: String) {
		val remaining = store.remove(profileId)
		_ui.update { state ->
			state.copy(
				profiles = remaining,
				activeProfile = state.activeProfile?.takeIf { it.id != profileId },
			)
		}
	}

	// ---- Refresh --------------------------------------------------------------

	private suspend fun refreshAll() {
		refreshMessages()
		refreshState()
		resyncEvents()
		refreshSessions()
		refreshModels()
	}

	private suspend fun refreshMessages() {
		try {
			val response = client.command("get_messages")
			val messages = Protocol.parseMessages(Protocol.obj(response["data"]))
			_ui.update { it.copy(messages = messages.filter { m -> m.text.isNotBlank() || m.role == "user" }) }
			mirrorDirty = true
		} catch (_: Exception) {
			// Streaming refresh is best-effort; the next turn boundary retries.
		}
	}

	private suspend fun refreshState() {
		try {
			val response = client.command("get_state")
			val snapshot = Protocol.parseSessionState(Protocol.obj(response["data"]))
			_ui.update {
				it.copy(
					isStreaming = snapshot.isStreaming,
					thinkingLevel = snapshot.thinkingLevel ?: it.thinkingLevel,
					currentModel = snapshot.modelId ?: it.currentModel,
					safeMode = snapshot.safeMode ?: it.safeMode,
				)
			}
		} catch (_: Exception) {
		}
	}

	private suspend fun refreshSessions() {
		try {
			val response = client.command("list_sessions")
			val sessions = Protocol.parseSessions(Protocol.obj(response["data"]))
			_ui.update { it.copy(sessions = sessions) }
		} catch (_: Exception) {
		}
	}

	private suspend fun refreshModels() {
		try {
			val response = client.command("get_available_models")
			val models = Protocol.parseModels(Protocol.obj(response["data"]))
			_ui.update { it.copy(models = models) }
		} catch (_: Exception) {
		}
	}

	private suspend fun resyncEvents() {
		try {
			val fields = buildJsonObject {
				put("limit", RESYNC_LIMIT)
				if (cursor > 0) put("sinceSequence", cursor)
			}
			val response = client.command("events.resync", fields, timeoutMs = 60_000)
			val data = Protocol.obj(response["data"]) ?: return
			val events = Protocol.arr(data["events"])
				?.mapNotNull { element ->
					val event = element as? JsonObject ?: return@mapNotNull null
					TimelineEvent(
						sequence = Protocol.long(event, "sequence"),
						type = Protocol.str(event, "type") ?: return@mapNotNull null,
						summary = Protocol.eventSummary(event["payload"]),
						timestamp = Protocol.long(event, "timestamp"),
						eventId = Protocol.str(event, "event_id"),
					)
				}
				.orEmpty()
			events.forEach { event -> event.sequence?.let { seq -> if (seq > cursor) cursor = seq } }
			val complete = Protocol.bool(data, "complete") ?: true
			_ui.update { state ->
				// complete=false means the phone was offline longer than the
				// fetch window: drop the mirror and start over from the tail.
				val base = if (complete) state.events else emptyList()
				state.copy(events = (base + events).takeLast(MAX_BUFFERED_EVENTS))
			}
			mirrorDirty = true
			if (!complete) {
				cursor = 0
				resyncEvents()
			}
		} catch (_: Exception) {
		}
	}

	// ---- User actions ----------------------------------------------------------

	/** Send a prompt; while the agent is running the message becomes a steer. */
	fun sendPrompt(text: String, images: List<Pair<String, String>> = emptyList()) {
		val body = text.trim()
		if (body.isEmpty() && images.isEmpty()) return
		if (!_ui.value.connected) return
		val agentBusy = _ui.value.isStreaming
		_ui.update { it.copy(isStreaming = true) }
		viewModelScope.launch {
			try {
				val fields = buildJsonObject {
					put("message", body)
					if (images.isNotEmpty()) {
						putJsonArray("images") {
							images.forEach { (base64, mime) ->
								addJsonObject {
									put("type", "image")
									put("data", base64)
									put("mimeType", mime)
								}
							}
						}
					}
				}
				if (agentBusy) {
					client.command("steer", fields)
				} else {
					client.command("prompt", fields)
				}
				// Optimistic echo; the authoritative copy arrives via the log.
				val echoed = if (images.isNotEmpty()) "$body\n[图片×${images.size}]" else body
				_ui.update { it.copy(messages = it.messages + ChatMessage("user", echoed)) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "发送失败") }
			}
		}
	}

	fun abort() {
		viewModelScope.launch {
			try {
				client.command("abort")
			} catch (_: Exception) {
			}
		}
	}

	fun setModel(model: ModelInfoDto) {
		val provider = model.provider ?: return
		viewModelScope.launch {
			try {
				val fields = buildJsonObject {
					put("provider", provider)
					put("modelId", model.id)
				}
				client.command("set_model", fields)
				_ui.update { it.copy(currentModel = model.id) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "切换模型失败") }
			}
		}
	}

	fun setThinkingLevel(level: String) {
		viewModelScope.launch {
			try {
				val fields = buildJsonObject { put("level", level) }
				client.command("set_thinking_level", fields)
				_ui.update { it.copy(thinkingLevel = level) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "设置失败") }
			}
		}
	}

	// ---- Approval flow (safe mode) ----------------------------------------------

	fun approve(eventId: String) = resolveApproval(eventId, "approve")
	fun reject(eventId: String) = resolveApproval(eventId, "reject")

	private fun resolveApproval(eventId: String, command: String) {
		_ui.update { state -> state.copy(pendingApprovals = state.pendingApprovals.filterNot { it.eventId == eventId }) }
		viewModelScope.launch {
			try {
				client.command(command, buildJsonObject { put("intentEventId", eventId) })
				refreshMessages()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "操作失败") }
			}
		}
	}

	fun toggleSafeMode() {
		val target = !_ui.value.safeMode
		viewModelScope.launch {
			try {
				client.command("set_safe_mode", buildJsonObject { put("enabled", target) })
				_ui.update { it.copy(safeMode = target) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "设置失败") }
			}
		}
	}

	// ---- Sessions & branches ----------------------------------------------------

	/** Public wrapper for manual refresh (Sessions screen). */
	fun loadSessions() {
		viewModelScope.launch { refreshSessions() }
	}

	fun newSession() {
		viewModelScope.launch {
			try {
				client.command("new_session")
				refreshMessages()
				refreshSessions()
				_ui.update { it.copy(error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "新建会话失败") }
			}
		}
	}

	fun switchSession(sessionId: String) {
		viewModelScope.launch {
			try {
				client.command("switch_session", buildJsonObject { put("sessionPath", sessionId) })
				cursor = 0
				_ui.update { it.copy(messages = emptyList(), events = emptyList()) }
				refreshMessages()
				resyncEvents()
				_ui.update { it.copy(error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "切换会话失败") }
			}
		}
	}

	fun loadHistory() {
		viewModelScope.launch {
			try {
				val response = client.command(
					"history_tree",
					buildJsonObject { put("action", "list") },
				)
				val nodes = Protocol.parseHistoryNodes(Protocol.obj(response["data"]))
				_ui.update { it.copy(history = nodes) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载分支树失败") }
			}
		}
	}

	fun forkSession(sessionId: String) {
		viewModelScope.launch {
			try {
				client.command(
					"history_tree",
					buildJsonObject {
						put("action", "fork")
						put("sessionId", sessionId)
					},
				)
				refreshMessages()
				loadHistory()
				_ui.update { it.copy(error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "分叉失败") }
			}
		}
	}

	// ---- Scheduled tasks ----------------------------------------------------------

	fun loadSchedules() {
		viewModelScope.launch {
			try {
				val response = client.command("schedule_list")
				val tasks = Protocol.parseSchedules(Protocol.obj(response["data"]))
				_ui.update { it.copy(schedules = tasks) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载计划任务失败") }
			}
		}
	}

	fun createSchedule(name: String, prompt: String, hour: Int, minute: Int) {
		if (name.isBlank() || prompt.isBlank()) return
		_ui.update { it.copy(busy = "创建任务中…") }
		viewModelScope.launch {
			try {
				val task = buildJsonObject {
					put("name", name.trim())
					put("prompt", prompt.trim())
					put("scope", "main")
					put("schedule", buildJsonObject {
						put("mode", "daily")
						putJsonArray("times") {
							addJsonObject {
								put("hour", hour)
								put("minute", minute)
							}
						}
					})
					put("enabled", true)
				}
				client.command("schedule_create", buildJsonObject { put("task", task) })
				loadSchedules()
				_ui.update { it.copy(busy = null, error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(busy = null, error = error.message ?: "创建失败") }
			}
		}
	}

	fun toggleSchedule(task: ScheduleTask) {
		viewModelScope.launch {
			try {
				client.command(
					"schedule_update",
					buildJsonObject {
						put("taskId", task.id)
						put("scope", task.scope)
						put("patch", buildJsonObject { put("enabled", !task.enabled) })
					},
				)
				loadSchedules()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "更新失败") }
			}
		}
	}

	fun deleteSchedule(task: ScheduleTask) {
		viewModelScope.launch {
			try {
				client.command(
					"schedule_delete",
					buildJsonObject {
						put("taskId", task.id)
						put("scope", task.scope)
					},
				)
				loadSchedules()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "删除失败") }
			}
		}
	}

	fun runScheduleNow(task: ScheduleTask) {
		viewModelScope.launch {
			try {
				client.command(
					"schedule_run_now",
					buildJsonObject {
						put("taskId", task.id)
						put("scope", task.scope)
					},
				)
				_ui.update { it.copy(error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "触发失败") }
			}
		}
	}

	// ---- Skills / SOPs / Extensions -------------------------------------------------

	fun loadSkills() {
		viewModelScope.launch {
			try {
				val response = client.command("get_skills")
				_ui.update { it.copy(skills = Protocol.parseSkills(Protocol.obj(response["data"]))) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载技能失败") }
			}
		}
	}

	fun installSkill(source: String, slug: String) {
		installByCommand("install_skill", source, slug)
	}

	fun loadSops() {
		viewModelScope.launch {
			try {
				val response = client.command("sop_market")
				_ui.update { it.copy(sops = Protocol.parseSops(Protocol.obj(response["data"]))) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载 SOP 失败") }
			}
		}
	}

	fun installSop(slug: String) = installByCommand("sop_install", "builtin", slug)
	fun uninstallSop(slug: String) = installByCommand("sop_uninstall", "builtin", slug)

	fun loadExtensions() {
		viewModelScope.launch {
			try {
				val response = client.command("get_extensions")
				_ui.update { it.copy(extensions = Protocol.parseExtensions(Protocol.obj(response["data"]))) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载扩展失败") }
			}
		}
	}

	fun toggleExtension(id: String, enabled: Boolean) {
		viewModelScope.launch {
			try {
				client.command(
					"set_extension_enabled",
					buildJsonObject {
						put("extensionId", id)
						put("enabled", enabled)
					},
				)
				loadExtensions()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "切换失败") }
			}
		}
	}

	private fun installByCommand(command: String, source: String, slug: String) {
		_ui.update { it.copy(busy = "安装中…") }
		viewModelScope.launch {
			try {
				val fields = buildJsonObject {
					put("source", source)
					put("slug", slug.trim())
				}
				client.command(command, fields, timeoutMs = 60_000)
				if (command == "install_skill") loadSkills() else loadSops()
				_ui.update { it.copy(busy = null, error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(busy = null, error = error.message ?: "安装失败") }
			}
		}
	}

	// ---- Skins & pets -------------------------------------------------------------

	fun loadSkins() {
		viewModelScope.launch {
			try {
				val response = client.command("skin_state")
				_ui.update { it.copy(skins = Protocol.parseSkins(Protocol.obj(response["data"]))) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载皮肤失败") }
			}
		}
	}

	fun applySkin(skinId: String) {
		viewModelScope.launch {
			try {
				client.command("skin_apply", buildJsonObject { put("skinId", skinId) })
				loadSkins()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "应用皮肤失败") }
			}
		}
	}

	fun loadPet() {
		viewModelScope.launch {
			try {
				val response = client.command("pet_state")
				_ui.update { it.copy(pet = Protocol.parsePetState(Protocol.obj(response["data"]))) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载宠物失败") }
			}
		}
	}

	fun hatchPet() {
		viewModelScope.launch {
			try {
				client.command("pet_hatch")
				loadPet()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "开盒失败") }
			}
		}
	}

	fun interactPet(action: String, petId: String) {
		viewModelScope.launch {
			try {
				client.command(
					"pet_interact",
					buildJsonObject {
						put("action", action)
						put("petId", petId)
					},
				)
				loadPet()
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "互动失败") }
			}
		}
	}

	// ---- Replay ----------------------------------------------------------------------

	fun loadReplayList() {
		viewModelScope.launch {
			try {
				val response = client.command("list_replay_sessions")
				_ui.update { it.copy(replaySessions = Protocol.parseReplayList(Protocol.obj(response["data"]))) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载回放列表失败") }
			}
		}
	}

	fun startReplay(sessionId: String) {
		viewModelScope.launch {
			try {
				val response = client.command(
					"get_events",
					buildJsonObject {
						put("sessionId", sessionId)
						put("limit", 2000)
					},
					timeoutMs = 60_000,
				)
				val data = Protocol.obj(response["data"])
				val events = Protocol.arr(data?.get("events"))
					?.mapNotNull { element ->
						val event = element as? JsonObject ?: return@mapNotNull null
						TimelineEvent(
							sequence = Protocol.long(event, "sequence"),
							type = Protocol.str(event, "type") ?: return@mapNotNull null,
							summary = Protocol.eventSummary(event["payload"]),
							timestamp = Protocol.long(event, "timestamp"),
							eventId = Protocol.str(event, "event_id"),
						)
					}
					.orEmpty()
					.filter { it.type in REPLAY_VISIBLE }
				_ui.update { it.copy(replayEvents = events, replayIndex = if (events.isEmpty()) -1 else 0, replayPlaying = false) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "加载回放失败") }
			}
		}
	}

	fun replayExit() {
		replayJob?.cancel()
		_ui.update { it.copy(replayEvents = emptyList(), replayIndex = -1, replayPlaying = false) }
		loadReplayList()
	}

	fun replayTogglePlay() {
		val playing = !_ui.value.replayPlaying
		_ui.update { it.copy(replayPlaying = playing) }
		replayJob?.cancel()
		if (playing) {
			replayJob = viewModelScope.launch {
				while (isActive && _ui.value.replayPlaying) {
					delay(REPLAY_STEP_MS)
					val current = _ui.value
					if (current.replayIndex < current.replayEvents.size - 1) {
						_ui.update { it.copy(replayIndex = it.replayIndex + 1) }
					} else {
						_ui.update { it.copy(replayPlaying = false) }
						break
					}
				}
			}
		}
	}

	fun replaySeek(index: Int) {
		_ui.update { it.copy(replayIndex = index.coerceIn(0, it.replayEvents.size - 1)) }
	}

	// ---- Provider keys (see ProviderConfigScreen) ------------------------------------

	fun setApiKey(provider: String, apiKey: String) {
		if (provider.isBlank() || apiKey.isBlank()) return
		_ui.update { it.copy(busy = "保存密钥中…") }
		viewModelScope.launch {
			try {
				val fields = buildJsonObject {
					put("provider", provider.trim())
					put("apiKey", apiKey.trim())
				}
				client.command("auth_set", fields)
				refreshModels()
				_ui.update { it.copy(busy = null, error = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(busy = null, error = error.message ?: "保存失败") }
			}
		}
	}

	fun removeApiKey(provider: String) {
		_ui.update { it.copy(busy = "移除密钥中…") }
		viewModelScope.launch {
			try {
				val fields = buildJsonObject { put("provider", provider.trim()) }
				client.command("auth_remove", fields)
				refreshModels()
				_ui.update { it.copy(busy = null) }
			} catch (error: Exception) {
				_ui.update { it.copy(busy = null, error = error.message ?: "移除失败") }
			}
		}
	}

	// ---- Composer attachments ----------------------------------------------------

	/** Read a picked image into a base64 part (kept in memory only, until sent). */
	fun attachImage(uri: android.net.Uri) {
		viewModelScope.launch {
			try {
				val resolver = getApplication<Application>().contentResolver
				val mime = resolver.getType(uri) ?: "image/jpeg"
				val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@launch
				if (bytes.size > MAX_IMAGE_BYTES) {
					_ui.update { it.copy(error = "图片超过 8MB，请压缩后重试") }
					return@launch
				}
				val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
				_ui.update { it.copy(attachedImages = it.attachedImages + (base64 to mime)) }
			} catch (error: Exception) {
				_ui.update { it.copy(error = error.message ?: "读取图片失败") }
			}
		}
	}

	fun clearAttachedImages() {
		_ui.update { it.copy(attachedImages = emptyList()) }
	}

	companion object {
		private const val MAX_BUFFERED_EVENTS = 3000
		private const val RESYNC_LIMIT = 2000
		private const val REPLAY_STEP_MS = 400L
		private const val MAX_IMAGE_BYTES = 8 * 1024 * 1024

		/** Event types that change the rendered conversation. */
		private val REFRESH_ON = setOf(
			"USER_MESSAGE",
			"AGENT_MESSAGE_END",
			"TOOL_EXECUTION_START",
			"TOOL_EXECUTION_END",
			"FILE_MUTATION_APPLIED",
			"COMMAND_EXECUTED",
			"MODEL_CHANGED",
		)

		/** Engine failures that should be surfaced as a banner, not buried in the log. */
		private val ERROR_EVENTS = setOf(
			"AGENT_ERROR",
			"LLM_CALL_FAILED",
			"RUNTIME_ERROR",
		)

		/** Event types shown in the replay player (chatter filtered out). */
		private val REPLAY_VISIBLE = setOf(
			"USER_MESSAGE",
			"AGENT_MESSAGE_END",
			"TOOL_EXECUTION_START",
			"TOOL_EXECUTION_END",
			"FILE_MUTATION_APPLIED",
			"COMMAND_EXECUTED",
		)
	}
}

enum class Tab(val label: String) {
	CHAT("对话"),
	TIMELINE("时间线"),
	TOOLBOX("工具箱"),
	SERVERS("服务器"),
}
