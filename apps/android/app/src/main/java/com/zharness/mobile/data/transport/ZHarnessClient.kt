package com.zharness.mobile.data.transport

import com.zharness.mobile.data.protocol.CommandException
import com.zharness.mobile.data.protocol.Protocol
import com.zharness.mobile.data.protocol.ServerProfile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap

/**
 * WebSocket transport to `zharness serve`.
 *
 * Frames in:  { type: "response", id, command, success, data?, error? }
 *             { type: "event", event: {...} }
 *             { type: "hello" | "pong", ... }
 * Frames out: RpcCommand JSON objects — the same table as `--mode rpc`.
 *
 * Reconnects with exponential backoff while [connect]ed; after every
 * reconnection the ViewModel replays the event log with events.resync, so a
 * dropped mobile connection loses nothing (the log is the source of truth).
 */
class ZHarnessClient(
	private val okHttp: OkHttpClient,
	private val scope: CoroutineScope,
) {
	enum class ConnState { DISCONNECTED, CONNECTING, CONNECTED }

	private val _state = MutableStateFlow(ConnState.DISCONNECTED)
	val state: StateFlow<ConnState> = _state.asStateFlow()

	private val _frames = MutableSharedFlow<JsonObject>(
		extraBufferCapacity = 1024,
		onBufferOverflow = BufferOverflow.DROP_OLDEST,
	)
	val frames: SharedFlow<JsonObject> = _frames.asSharedFlow()

	private var webSocket: WebSocket? = null
	private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()

	@Volatile private var shouldStayConnected = false
	@Volatile private var reconnectAttempt = 0
	@Volatile private var activeProfile: ServerProfile? = null
	private val connectMutex = Mutex()

	fun connect(profile: ServerProfile) {
		scope.launch { doConnect(profile) }
	}

	private suspend fun doConnect(profile: ServerProfile) = connectMutex.withLock {
		if (!shouldStayConnected && activeProfile != null) {
			// disconnect() ran while this connect was queued.
			return@withLock
		}
		activeProfile = profile
		shouldStayConnected = true
		if (webSocket != null) return@withLock
		_state.value = ConnState.CONNECTING
		val request = Request.Builder().url(wsUrl(profile)).build()
		webSocket = okHttp.newWebSocket(request, listener)
	}

	private val listener = object : WebSocketListener() {
		override fun onOpen(webSocket: WebSocket, response: Response) {
			reconnectAttempt = 0
			_state.value = ConnState.CONNECTED
		}

		override fun onMessage(webSocket: WebSocket, text: String) {
			val frame = Protocol.parseFrame(text) ?: return
			val id = Protocol.str(frame, "id")
			if (Protocol.str(frame, "type") == "response" && id != null) {
				pending.remove(id)?.complete(frame)
			}
			_frames.tryEmit(frame)
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
			handleDown()
		}

		override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
			handleDown()
		}
	}

	private fun handleDown() {
		webSocket = null
		failPending("connection lost")
		_state.value = if (shouldStayConnected) ConnState.CONNECTING else ConnState.DISCONNECTED
		val profile = activeProfile ?: return
		if (shouldStayConnected && reconnectAttempt < 6) {
			val delayMs = minOf(1000L shl reconnectAttempt, 30_000L)
			reconnectAttempt += 1
			scope.launch {
				delay(delayMs)
				doConnect(profile)
			}
		}
	}

	fun disconnect() {
		shouldStayConnected = false
		activeProfile = null
		webSocket?.close(1000, "client disconnect")
		webSocket = null
		failPending("disconnected")
		_state.value = ConnState.DISCONNECTED
	}

	/**
	 * Send a command frame and await its response. Throws [CommandException]
	 * when the server reports success:false, or on timeout / disconnection.
	 */
	suspend fun command(
		type: String,
		fields: JsonObject = JsonObject(emptyMap()),
		timeoutMs: Long = 30_000,
	): JsonObject {
		val ws = webSocket ?: throw CommandException(type, "not connected")
		val id = Protocol.nextId()
		val frame = buildJsonObject {
			put("type", type)
			put("id", id)
			fields.forEach { (key, value) -> put(key, value) }
		}
		val deferred = CompletableDeferred<JsonObject>()
		pending[id] = deferred
		if (!ws.send(frame.toString())) {
			pending.remove(id)
			throw CommandException(type, "socket not writable")
		}
		val response = try {
			withTimeout(timeoutMs) { deferred.await() }
		} finally {
			pending.remove(id)
		}
		val success = Protocol.bool(response, "success") ?: false
		if (!success) {
			throw CommandException(type, Protocol.str(response, "error") ?: "command failed")
		}
		return response
	}

	private fun failPending(reason: String) {
		for (deferred in pending.values) {
			deferred.completeExceptionally(CommandException("pending", reason))
		}
		pending.clear()
	}

	private fun wsUrl(profile: ServerProfile): String {
		val tokenPart = profile.token?.let { token -> "?token=${java.net.URLEncoder.encode(token, "UTF-8")}" } ?: ""
		return "ws://${profile.host}:${profile.port}/ws$tokenPart"
	}
}

/** One-off unauthenticated connection used to exchange a pairing code. */
object PairingClient {
	suspend fun pair(
		okHttp: OkHttpClient,
		host: String,
		port: Int,
		code: String,
		deviceName: String,
		timeoutMs: Long = 15_000,
	): String {
		val result = CompletableDeferred<JsonObject>()
		val request = Request.Builder().url("ws://$host:$port/ws").build()
		val ws = okHttp.newWebSocket(request, object : WebSocketListener() {
			override fun onOpen(webSocket: WebSocket, response: Response) {
				val frame = buildJsonObject {
					put("id", Protocol.nextId())
					put("type", "pair.claim")
					put("code", code)
					put("deviceName", deviceName)
				}
				webSocket.send(frame.toString())
			}

			override fun onMessage(webSocket: WebSocket, text: String) {
				val frame = Protocol.parseFrame(text) ?: return
				if (Protocol.str(frame, "command") == "pair.claim") {
					result.complete(frame)
				}
			}

			override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
				result.completeExceptionally(t)
			}
		})
		try {
			val claimed = withTimeout(timeoutMs) { result.await() }
			val success = Protocol.bool(claimed, "success") ?: false
			if (!success) {
				throw CommandException("pair.claim", Protocol.str(claimed, "error") ?: "pairing failed")
			}
			return Protocol.str(Protocol.obj(claimed["data"]), "token")
				?: throw CommandException("pair.claim", "server returned no token")
		} finally {
			ws.close(1000, "done")
		}
	}
}
