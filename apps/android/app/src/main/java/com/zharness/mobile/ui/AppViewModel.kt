package com.zharness.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zharness.mobile.data.ServerStore
import com.zharness.mobile.data.protocol.ChatMessage
import com.zharness.mobile.data.protocol.ModelInfoDto
import com.zharness.mobile.data.protocol.Protocol
import com.zharness.mobile.data.protocol.ServerProfile
import com.zharness.mobile.data.protocol.SessionSummary
import com.zharness.mobile.data.protocol.TimelineEvent
import com.zharness.mobile.data.transport.PairingClient
import com.zharness.mobile.data.transport.ZHarnessClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * One screen of state shared by all tabs. Every mutation goes through
 * [_ui.update]; server frames arrive on the transport flow and are folded in
 * here — the UI itself is a pure projection of this state.
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {

	private val store = ServerStore(application)
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
	)

	private val _ui = MutableStateFlow(UiState(profiles = store.load()))
	val ui: StateFlow<UiState> = _ui.asStateFlow()

	/** Monotonic event-log cursor for incremental resync (design §06). */
	private var cursor: Long = 0

	init {
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
			if (!complete) {
				cursor = 0
				resyncEvents()
			}
		} catch (_: Exception) {
		}
	}

	// ---- User actions ----------------------------------------------------------

	/** Send a prompt; while the agent is running the message becomes a steer. */
	fun sendPrompt(text: String) {
		val body = text.trim()
		if (body.isEmpty() || !_ui.value.connected) return
		val agentBusy = _ui.value.isStreaming
		_ui.update { it.copy(isStreaming = true) }
		viewModelScope.launch {
			try {
				val fields = buildJsonObject { put("message", body) }
				if (agentBusy) {
					client.command("steer", fields)
				} else {
					client.command("prompt", fields)
				}
				// Optimistic echo; the authoritative copy arrives via the log.
				_ui.update { it.copy(messages = it.messages + ChatMessage("user", body)) }
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

	companion object {
		private const val MAX_BUFFERED_EVENTS = 3000
		private const val RESYNC_LIMIT = 2000

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
	}
}
