package com.zharness.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.zharness.mobile.ui.AppRoot
import com.zharness.mobile.ui.theme.ZharnessTheme

class MainActivity : ComponentActivity() {

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
}
