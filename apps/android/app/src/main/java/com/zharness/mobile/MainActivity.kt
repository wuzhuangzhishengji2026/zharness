package com.zharness.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.ui.AppRoot
import com.zharness.mobile.ui.theme.ZharnessTheme

class MainActivity : ComponentActivity() {

	private val notificationPermission = registerForActivityResult(
		ActivityResultContracts.RequestPermission(),
	) { /* denied: in-app banners still work, no system notifications */ }

	private fun handleIntent(intent: Intent?): Pair<String?, String?> {
		if (intent == null) return null to null
		val shared = if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain") {
			intent.getStringExtra(Intent.EXTRA_TEXT)
		} else null
		val pairUri = if (intent.action == Intent.ACTION_VIEW && intent.data?.scheme == "zharness") {
			intent.data.toString()
		} else null
		return shared to pairUri
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		requestNotificationPermissionIfNeeded()
		val (shared, pairUri) = handleIntent(intent)
		setContent {
			ZharnessTheme {
				AppRoot(
					initialShare = shared,
					initialPairUri = pairUri,
				)
			}
		}
	}

	override fun onStart() {
		super.onStart()
		EngineHub.setAppForeground(true)
	}

	override fun onStop() {
		EngineHub.setAppForeground(false)
		super.onStop()
	}

	private fun requestNotificationPermissionIfNeeded() {
		if (Build.VERSION.SDK_INT < 33) return
		val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
			PackageManager.PERMISSION_GRANTED
		if (!granted) {
			notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
		}
	}
}
