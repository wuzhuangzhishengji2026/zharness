package com.zharness.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.data.protocol.ModelInfoDto
import com.zharness.mobile.data.protocol.ServerProfile
import com.zharness.mobile.data.protocol.ScheduleTask
import kotlinx.coroutines.flow.StateFlow

/**
 * Thin delegator over the process-level [EngineHub]. All state and engine
 * interaction lives in the hub so the connection survives Activity/ViewModel
 * destruction (foreground service keeps the process alive in background).
 * Screens bind to [ui] and call these methods — nothing else.
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {

	val ui: StateFlow<EngineHub.UiState> = EngineHub.ui

	fun connect(profile: ServerProfile) = EngineHub.connect(profile)
	fun disconnect() = EngineHub.disconnect()
	fun pairAndConnect(input: String, portText: String, code: String, deviceName: String) =
		EngineHub.pairAndConnect(input, portText, code, deviceName)

	fun setPendingPairUri(uri: String) = EngineHub.setPendingPairUri(uri)
	fun consumePendingPairUri() = EngineHub.consumePendingPairUri()
	fun setPendingShare(text: String) = EngineHub.setPendingShare(text)
	fun consumePendingShare() = EngineHub.consumePendingShare()
	fun dismissError() = EngineHub.dismissError()
	fun selectTab(tab: Tab) = EngineHub.selectTab(tab)
	fun deleteProfile(profileId: String) = EngineHub.deleteProfile(profileId)

	fun sendPrompt(text: String, images: List<Pair<String, String>> = emptyList()) =
		EngineHub.sendPrompt(text, images)
	fun abort() = EngineHub.abort()
	fun setModel(model: ModelInfoDto) = EngineHub.setModel(model)
	fun setThinkingLevel(level: String) = EngineHub.setThinkingLevel(level)

	fun approve(eventId: String) = EngineHub.approve(eventId)
	fun reject(eventId: String) = EngineHub.reject(eventId)
	fun toggleSafeMode() = EngineHub.toggleSafeMode()

	fun loadSessions() = EngineHub.loadSessions()
	fun newSession() = EngineHub.newSession()
	fun switchSession(sessionId: String) = EngineHub.switchSession(sessionId)
	fun loadHistory() = EngineHub.loadHistory()
	fun forkSession(sessionId: String) = EngineHub.forkSession(sessionId)

	fun loadSchedules() = EngineHub.loadSchedules()
	fun createSchedule(name: String, prompt: String, hour: Int, minute: Int) =
		EngineHub.createSchedule(name, prompt, hour, minute)
	fun toggleSchedule(task: ScheduleTask) = EngineHub.toggleSchedule(task)
	fun deleteSchedule(task: ScheduleTask) = EngineHub.deleteSchedule(task)
	fun runScheduleNow(task: ScheduleTask) = EngineHub.runScheduleNow(task)

	fun loadSkills() = EngineHub.loadSkills()
	fun installSkill(source: String, slug: String) = EngineHub.installSkill(source, slug)
	fun loadSops() = EngineHub.loadSops()
	fun installSop(slug: String) = EngineHub.installSop(slug)
	fun uninstallSop(slug: String) = EngineHub.uninstallSop(slug)
	fun loadExtensions() = EngineHub.loadExtensions()
	fun toggleExtension(id: String, enabled: Boolean) = EngineHub.toggleExtension(id, enabled)

	fun loadSkins() = EngineHub.loadSkins()
	fun applySkin(skinId: String) = EngineHub.applySkin(skinId)
	fun loadPet() = EngineHub.loadPet()
	fun hatchPet() = EngineHub.hatchPet()
	fun interactPet(action: String, petId: String) = EngineHub.interactPet(action, petId)

	fun loadReplayList() = EngineHub.loadReplayList()
	fun startReplay(sessionId: String) = EngineHub.startReplay(sessionId)
	fun replayExit() = EngineHub.replayExit()
	fun replayTogglePlay() = EngineHub.replayTogglePlay()
	fun replaySeek(index: Int) = EngineHub.replaySeek(index)

	fun setApiKey(provider: String, apiKey: String) = EngineHub.setApiKey(provider, apiKey)
	fun removeApiKey(provider: String) = EngineHub.removeApiKey(provider)

	fun attachImage(uri: android.net.Uri) = EngineHub.attachImage(uri)
	fun clearAttachedImages() = EngineHub.clearAttachedImages()
}

enum class Tab(val label: String) {
	CHAT("对话"),
	TIMELINE("时间线"),
	TOOLBOX("工具箱"),
	SERVERS("服务器"),
}
