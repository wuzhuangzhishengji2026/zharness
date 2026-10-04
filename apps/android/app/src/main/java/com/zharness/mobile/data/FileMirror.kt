package com.zharness.mobile.data

import android.content.Context
import com.zharness.mobile.data.protocol.ChatMessage
import com.zharness.mobile.data.protocol.Protocol
import com.zharness.mobile.data.protocol.TimelineEvent
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.util.concurrent.atomic.AtomicBoolean

@Serializable
public data class MirrorSnapshot(
	val messages: List<ChatMessage> = emptyList(),
	val events: List<TimelineEvent> = emptyList(),
)

/**
 * File-based offline mirror (design doc §06 — M1 deliverable). The whole
 * projected state (conversation + timeline) is snapshotted to app-private
 * storage so history stays browsable when the engine is unreachable. The
 * append-only log on the engine remains the source of truth; a stale mirror
 * is always healed by events.resync on the next connection.
 */
class FileMirror(context: Context) {

	private val file = java.io.File(context.filesDir, "mirror.json")
	private val saving = AtomicBoolean(false)

	fun load(): MirrorSnapshot? = runCatching {
		if (!file.exists()) return null
		Protocol.json.decodeFromString<MirrorSnapshot>(file.readText())
	}.getOrNull()

	fun save(messages: List<ChatMessage>, events: List<TimelineEvent>) {
		if (!saving.compareAndSet(false, true)) return
		try {
			val snapshot = MirrorSnapshot(
				messages = messages.takeLast(MAX_MESSAGES),
				events = events.takeLast(MAX_EVENTS),
			)
			file.writeText(Protocol.json.encodeToString(snapshot))
		} catch (_: Exception) {
			// The mirror is best-effort; the engine log is authoritative.
		} finally {
			saving.set(false)
		}
	}

	companion object {
		private const val MAX_MESSAGES = 400
		private const val MAX_EVENTS = 2000
	}
}
