package com.zharness.mobile.data.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

// ============================================================================
// Wire models (defensive subset of @zharness/protocol)
// ============================================================================

@kotlinx.serialization.Serializable
data class ServerProfile(
	val id: String,
	val name: String,
	val host: String,
	val port: Int,
	val token: String? = null,
	val workspace: String? = null,
	val createdAt: Long = System.currentTimeMillis(),
)

data class ChatMessage(val role: String, val text: String)

data class TimelineEvent(
	val sequence: Long?,
	val type: String,
	val summary: String,
	val timestamp: Long?,
	val eventId: String?,
)

data class ModelInfoDto(
	val id: String,
	val name: String?,
	val provider: String?,
	val hasAuth: Boolean,
	val reasoning: Boolean,
)

data class SessionSummary(
	val sessionId: String,
	val title: String,
	val createdAt: Long?,
)

data class SessionSnapshot(
	val sessionId: String?,
	val isStreaming: Boolean,
	val thinkingLevel: String?,
	val modelId: String?,
	val modelProvider: String?,
)

class CommandException(val command: String, message: String) : Exception(message)

// ============================================================================
// JSON helpers — every server frame is parsed defensively: the bridge may add
// fields, and messages/payloads are free-form on the wire.
// ============================================================================

object Protocol {
	val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

	private var counter = 0
	fun nextId(): String = "m-${System.currentTimeMillis() % 1_000_000}-${counter++}"

	/** Parse a wire frame; returns null for anything that is not a JSON object. */
	fun parseFrame(text: String): JsonObject? = runCatching {
		json.parseToJsonElement(text) as? JsonObject
	}.getOrNull()

	fun str(obj: JsonObject?, key: String): String? = (obj?.get(key) as? JsonPrimitive)?.contentOrNull
	fun bool(obj: JsonObject?, key: String): Boolean? = (obj?.get(key) as? JsonPrimitive)?.booleanOrNull
	fun long(obj: JsonObject?, key: String): Long? = (obj?.get(key) as? JsonPrimitive)?.longOrNull

	fun obj(element: JsonElement?): JsonObject? = element as? JsonObject
	fun arr(element: JsonElement?): JsonArray? = element as? JsonArray

	/** Message content arrives either as a plain string or a block array. */
	fun messageText(content: JsonElement?): String = when (content) {
		is JsonPrimitive -> content.contentOrNull ?: ""
		is JsonArray -> content.joinToString("") { block ->
			str(block as? JsonObject, "text") ?: ""
		}
		else -> ""
	}

	fun parseMessages(data: JsonObject?): List<ChatMessage> {
		val messages = arr(data?.get("messages")) ?: return emptyList()
		return messages.mapNotNull { element ->
			val message = element as? JsonObject ?: return@mapNotNull null
			val role = str(message, "role") ?: return@mapNotNull null
			ChatMessage(role, messageText(message["content"]))
		}
	}

	fun parseSessionState(data: JsonObject?): SessionSnapshot {
		val model = obj(data?.get("model"))
		return SessionSnapshot(
			sessionId = str(data, "sessionId"),
			isStreaming = bool(data, "isStreaming") ?: false,
			thinkingLevel = str(data, "thinkingLevel"),
			modelId = str(model, "id"),
			modelProvider = str(model, "provider"),
		)
	}

	fun parseModels(data: JsonObject?): List<ModelInfoDto> {
		val models = arr(data?.get("models")) ?: return emptyList()
		return models.mapNotNull { element ->
			val model = element as? JsonObject ?: return@mapNotNull null
			val id = str(model, "id") ?: return@mapNotNull null
			ModelInfoDto(
				id = id,
				name = str(model, "name") ?: id,
				provider = str(model, "provider"),
				hasAuth = bool(model, "hasAuth") ?: true,
				reasoning = bool(model, "reasoning") ?: false,
			)
		}
	}

	fun parseSessions(data: JsonObject?): List<SessionSummary> {
		val sessions = arr(data?.get("sessions")) ?: return emptyList()
		return sessions.mapNotNull { element ->
			val session = element as? JsonObject ?: return@mapNotNull null
			val sessionId = str(session, "session_id") ?: return@mapNotNull null
			SessionSummary(
				sessionId = sessionId,
				title = str(session, "title") ?: sessionId,
				createdAt = long(session, "created_at"),
			)
		}
	}

	/** One-line human summary of an event payload for the timeline list. */
	fun eventSummary(payload: JsonElement?): String = when (payload) {
		is JsonPrimitive -> payload.contentOrNull ?: ""
		is JsonObject -> payload.entries.take(4).joinToString(" ") { (key, value) ->
			val rendered = when (value) {
				is JsonPrimitive -> value.contentOrNull ?: "?"
				else -> "…"
			}
			"$key=$rendered"
		}
		else -> ""
	}
}
