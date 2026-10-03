package com.zharness.mobile.data

import android.content.Context
import com.zharness.mobile.data.protocol.Protocol
import com.zharness.mobile.data.protocol.ServerProfile
import kotlinx.serialization.encodeToString
import java.util.UUID

/**
 * Server profiles persisted in app-private storage. The device token is the
 * only secret held on the phone — model API keys never leave the host.
 */
class ServerStore(context: Context) {
	private val prefs = context.getSharedPreferences("zharness_servers", Context.MODE_PRIVATE)

	fun load(): List<ServerProfile> = runCatching {
		val raw = prefs.getString(KEY, null) ?: return emptyList()
		Protocol.json.decodeFromString<List<ServerProfile>>(raw)
	}.getOrDefault(emptyList())

	fun save(profiles: List<ServerProfile>) {
		prefs.edit().putString(KEY, Protocol.json.encodeToString(profiles)).apply()
	}

	fun upsert(profile: ServerProfile): List<ServerProfile> {
		val next = load().filterNot { it.id == profile.id } + profile
		save(next)
		return next
	}

	fun remove(profileId: String): List<ServerProfile> {
		val next = load().filterNot { it.id == profileId }
		save(next)
		return next
	}

	companion object {
		private const val KEY = "profiles"

		fun newId(): String = UUID.randomUUID().toString()
	}
}
