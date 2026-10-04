package com.zharness.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class ZHarnessApp : Application() {

	override fun onCreate() {
		super.onCreate()
		instance = this
		com.zharness.mobile.data.EngineHub.init(this)
		createNotificationChannels()
	}

	private fun createNotificationChannels() {
		val manager = getSystemService(NotificationManager::class.java)
		manager.createNotificationChannel(
			NotificationChannel(CHANNEL_CONNECTION, "引擎连接", NotificationManager.IMPORTANCE_LOW).apply {
				description = "本机/远程引擎连接保持"
			},
		)
		manager.createNotificationChannel(
			NotificationChannel(CHANNEL_APPROVALS, "工具审批", NotificationManager.IMPORTANCE_HIGH).apply {
				description = "安全模式下等待你允许/拒绝的工具调用"
			},
		)
		manager.createNotificationChannel(
			NotificationChannel(CHANNEL_ENGINE, "引擎事件", NotificationManager.IMPORTANCE_DEFAULT).apply {
				description = "报错与任务完成"
			},
		)
	}

	companion object {
		const val CHANNEL_CONNECTION = "connection"
		const val CHANNEL_APPROVALS = "approvals"
		const val CHANNEL_ENGINE = "engine"

		@Volatile
		var instance: ZHarnessApp? = null
			private set
	}
}
