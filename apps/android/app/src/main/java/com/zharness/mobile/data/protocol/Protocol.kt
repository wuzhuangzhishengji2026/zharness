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

@kotlinx.serialization.Serializable
data class ChatMessage(val role: String, val text: String)

@kotlinx.serialization.Serializable
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
	val safeMode: Boolean?,
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
			safeMode = bool(data, "safeMode"),
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

	// ---- Payload parsers for the toolbox features (all defensive) ------------

	fun parseStringArray(data: JsonObject?, key: String): List<String> =
		arr(data?.get(key))?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

	fun parseSchedules(data: JsonObject?): List<ScheduleTask> {
		val tasks = arr(data?.get("tasks")) ?: return emptyList()
		return tasks.mapNotNull { element ->
			val task = element as? JsonObject ?: return@mapNotNull null
			val id = str(task, "id") ?: return@mapNotNull null
			ScheduleTask(
				id = id,
				name = str(task, "name") ?: id,
				prompt = str(task, "prompt") ?: "",
				enabled = bool(task, "enabled") ?: false,
				scope = str(task, "scope") ?: "main",
				scheduleSummary = scheduleSummary(obj(task["schedule"])),
				runCount = long(task, "runCount") ?: 0,
				lastRunStatus = str(task, "lastRunStatus"),
			)
		}
	}

	/** Human summary of a ScheduleSpec (mode/times/cron). */
	fun scheduleSummary(spec: JsonObject?): String {
		if (spec == null) return "?"
		val mode = str(spec, "mode") ?: return "?"
		return when (mode) {
			"once" -> "单次"
			"every_n_minutes" -> {
				val every = obj(spec["everyN"])
				"每 ${long(every, "n") ?: 1} ${if (str(every, "unit") == "hour") "小时" else "分钟"}"
			}
			"daily" -> "每天 " + (arr(spec["times"])?.mapNotNull { primitiveTime(it) }?.joinToString("/") ?: "")
			"weekdays" -> "工作日 " + (arr(spec["times"])?.mapNotNull { primitiveTime(it) }?.joinToString("/") ?: "")
			"weekly" -> "每周 " + (arr(spec["times"])?.mapNotNull { primitiveTime(it) }?.joinToString("/") ?: "")
			"monthly" -> "每月 " + (arr(spec["times"])?.mapNotNull { primitiveTime(it) }?.joinToString("/") ?: "")
			"cron" -> "cron: " + (str(obj(spec["cron"]), "expression") ?: "?")
			else -> mode
		}
	}

	private fun primitiveTime(element: JsonElement?): String? {
		val obj = element as? JsonObject ?: return (element as? JsonPrimitive)?.contentOrNull
		val hour = long(obj, "hour") ?: return null
		val minute = long(obj, "minute") ?: 0
		return "%02d:%02d".format(hour, minute)
	}

	fun parseHistoryNodes(data: JsonObject?): List<HistoryNode> {
		val nodes = arr(data?.get("nodes")) ?: return emptyList()
		return nodes.mapNotNull { element ->
			val node = element as? JsonObject ?: return@mapNotNull null
			val sessionId = str(node, "session_id") ?: return@mapNotNull null
			HistoryNode(
				sessionId = sessionId,
				name = str(node, "name") ?: sessionId.take(8),
				depth = long(node, "depth") ?: 0,
				isActive = bool(node, "is_active") ?: false,
				snippet = str(node, "snippet"),
				createdAt = long(node, "created_at"),
			)
		}
	}

	fun parseSkills(data: JsonObject?): List<NamedEntry> {
		val skills = arr(data?.get("skills")) ?: return emptyList()
		return skills.mapNotNull { element ->
			val skill = element as? JsonObject ?: return@mapNotNull null
			val name = str(skill, "name") ?: return@mapNotNull null
			NamedEntry(
				id = str(skill, "command") ?: name,
				name = name,
				description = str(skill, "description"),
				installed = true,
				kind = str(skill, "source"),
			)
		}
	}

	fun parseSops(data: JsonObject?): List<NamedEntry> {
		val entries = arr(data?.get("entries")) ?: return emptyList()
		return entries.mapNotNull { element ->
			val entry = element as? JsonObject ?: return@mapNotNull null
			val slug = str(entry, "slug") ?: return@mapNotNull null
			NamedEntry(
				id = slug,
				name = str(entry, "name") ?: slug,
				description = str(entry, "description"),
				installed = bool(entry, "installed") ?: false,
				kind = str(entry, "kind"),
			)
		}
	}

	fun parseExtensions(data: JsonObject?): List<NamedEntry> {
		val extensions = arr(data?.get("extensions")) ?: return emptyList()
		return extensions.mapNotNull { element ->
			val ext = element as? JsonObject ?: return@mapNotNull null
			val id = str(ext, "id") ?: return@mapNotNull null
			NamedEntry(
				id = id,
				name = str(ext, "name") ?: id,
				description = str(ext, "description"),
				installed = true,
				kind = str(ext, "kind"),
				enabled = bool(ext, "enabled") ?: false,
				canToggle = bool(ext, "canToggle") ?: false,
			)
		}
	}

	fun parseSkins(data: JsonObject?): List<SkinInfo> {
		val skins = arr(data?.get("skins")) ?: return emptyList()
		return skins.mapNotNull { element ->
			val skin = element as? JsonObject ?: return@mapNotNull null
			val id = str(skin, "id") ?: return@mapNotNull null
			SkinInfo(
				id = id,
				name = str(skin, "name") ?: id,
				kind = str(skin, "kind") ?: "builtin",
				description = str(skin, "description"),
				active = str(data, "activeSkinId") == id,
			)
		}
	}

	fun parsePetState(data: JsonObject?): PetInfo? {
		val view = obj(data?.get("activePetView")) ?: return null
		val pet = obj(view["pet"]) ?: return null
		return PetInfo(
			id = str(pet, "id") ?: return null,
			name = str(pet, "name") ?: "?",
			species = str(view, "speciesName") ?: "",
			emoji = str(view, "speciesEmoji") ?: "🐾",
			personality = str(view, "personalityName"),
			blurb = str(view, "blurb"),
			mood = long(pet, "mood") ?: 0,
			energy = long(pet, "energy") ?: 0,
			bond = long(pet, "bond") ?: 0,
		)
	}

	fun parsePendingApproval(event: JsonObject): PendingApproval? {
		val payload = obj(event["payload"]) ?: return null
		if (bool(payload, "requires_approval") != true) return null
		return PendingApproval(
			eventId = str(event, "event_id") ?: return null,
			toolName = str(payload, "tool_name") ?: "?",
			argumentsSummary = eventSummary(payload["arguments"]),
		)
	}

	fun parseReplayList(data: JsonObject?): List<NamedEntry> {
		val sessions = arr(data?.get("sessions")) ?: return emptyList()
		return sessions.mapNotNull { element ->
			val session = element as? JsonObject ?: return@mapNotNull null
			val sessionId = str(session, "sessionId") ?: str(session, "session_id") ?: return@mapNotNull null
			NamedEntry(
				id = sessionId,
				name = str(session, "taskName")?.takeIf { it.isNotBlank() }
					?: str(session, "name")
					?: sessionId.take(10),
				description = long(session, "updatedAt")?.let {
					java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(it))
				},
				installed = true,
				kind = null,
			)
		}
	}
}

// ============================================================================
// Toolbox data types
// ============================================================================

data class ScheduleTask(
	val id: String,
	val name: String,
	val prompt: String,
	val enabled: Boolean,
	val scope: String,
	val scheduleSummary: String,
	val runCount: Long,
	val lastRunStatus: String?,
)

data class HistoryNode(
	val sessionId: String,
	val name: String,
	val depth: Long,
	val isActive: Boolean,
	val snippet: String?,
	val createdAt: Long?,
)

data class NamedEntry(
	val id: String,
	val name: String,
	val description: String?,
	val installed: Boolean,
	val kind: String?,
	val enabled: Boolean? = null,
	val canToggle: Boolean? = null,
)

data class SkinInfo(
	val id: String,
	val name: String,
	val kind: String,
	val description: String?,
	val active: Boolean,
)

data class PetInfo(
	val id: String,
	val name: String,
	val species: String,
	val emoji: String,
	val personality: String?,
	val blurb: String?,
	val mood: Long,
	val energy: Long,
	val bond: Long,
)

data class PendingApproval(
	val eventId: String,
	val toolName: String,
	val argumentsSummary: String,
)
