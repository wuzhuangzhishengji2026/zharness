package com.zharness.mobile

import android.app.Notification
import android.app.PendingIntent
import android.app.NotificationManager
import android.app.Service
import com.zharness.mobile.data.EngineHub
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Foreground keep-alive service. While the engine connection is active the
 * process stays at foreground priority, so MIUI/Doze cannot freeze Termux's
 * peer (the WS) or this app when the UI goes background. It also relays
 * approvals/errors/turn-end events into system notifications — suppressed
 * while the app itself is on screen.
 */
class EngineService : Service() {

	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

	override fun onCreate() {
		super.onCreate()
		startForeground(NOTIFICATION_ID, buildNotification("保持引擎连接…"))
		scope.launch {
			EngineHub.ui.collect { state ->
				if (state.activeProfile == null) {
					stopSelf()
					return@collect
				}
				val status = when {
					state.connected -> "已连接 · ${state.workspaceName ?: state.activeProfile?.name ?: ""}"
					state.connecting -> "连接中…"
					else -> "连接断开，重连中…"
				}
				updateNotification(status)
			}
		}
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

	override fun onDestroy() {
		scope.cancel()
		super.onDestroy()
	}

	override fun onBind(intent: Intent?): IBinder? = null

	private fun buildNotification(text: String): Notification {
		val intent = Intent(this, MainActivity::class.java).apply {
			flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
		}
		val launch = PendingIntent.getActivity(
			this, 0, intent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)
		return NotificationCompat.Builder(this, ZHarnessApp.CHANNEL_CONNECTION)
			.setSmallIcon(R.drawable.ic_launcher_foreground)
			.setContentTitle("ZHarness 引擎在线")
			.setContentText(text)
			.setOngoing(true)
			.setContentIntent(launch)
			.build()
	}

	private fun updateNotification(text: String) {
		val manager = getSystemService(NotificationManager::class.java) ?: return
		manager.notify(NOTIFICATION_ID, buildNotification(text))
	}

	companion object {
		private const val NOTIFICATION_ID = 1001
	}
}
