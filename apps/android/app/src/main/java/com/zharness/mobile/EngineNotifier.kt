package com.zharness.mobile

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.data.protocol.PendingApproval

/**
 * Posts engine events as system notifications (approvals / errors / turn
 * completion). Suppressed while the app is in the foreground — the user is
 * already looking at the very same state on screen.
 */
object EngineNotifier {

	private val manager: NotificationManager? by lazy {
		(ZHarnessApp.instance?.getSystemService(Context.NOTIFICATION_SERVICE)) as? NotificationManager
	}

	private val suppressed: Boolean get() = EngineHub.appInForeground || manager == null

	private fun builder(channel: String, title: String, text: String): Notification =
		NotificationCompat.Builder(ZHarnessApp.instance!!, channel)
			.setSmallIcon(R.drawable.ic_launcher_foreground)
			.setContentTitle(title)
			.setContentText(text)
			.setStyle(NotificationCompat.BigTextStyle().bigText(text))
			.setAutoCancel(true)
			.build()

	fun notifyApproval(approval: PendingApproval) {
		if (suppressed) return
		val intent = Intent(ZHarnessApp.instance, MainActivity::class.java).apply {
			flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
		}
		val launch = android.app.PendingIntent.getActivity(
			ZHarnessApp.instance,
			approval.eventId.hashCode(),
			intent,
			android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
		)
		val notification = builder(ZHarnessApp.CHANNEL_APPROVALS, "工具等待审批", "🔧 ${approval.toolName} — 打开 App 允许或拒绝")
			.apply { contentIntent = launch }
		manager?.notify(approval.eventId.hashCode(), notification)
	}

	fun cancelApproval(eventId: String) {
		manager?.cancel(eventId.hashCode())
	}

	fun notifyError(id: Int, message: String) {
		if (suppressed) return
		manager?.notify(id, builder(ZHarnessApp.CHANNEL_ENGINE, "引擎报错", message))
	}

	fun notifyTurnEnd() {
		if (suppressed) return
		manager?.notify(TURN_END_ID, builder(ZHarnessApp.CHANNEL_ENGINE, "任务完成", "Agent 本轮已结束，点开查看结果"))
	}

	fun cancelAll() {
		manager?.cancelAll()
	}

	private const val TURN_END_ID = 424242
}
