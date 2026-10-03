package com.zharness.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Brand palette — mirrors the desktop/TUI dark theme.
private val Background = Color(0xFF0A0E14)
private val Surface = Color(0xFF111722)
private val SurfaceHigh = Color(0xFF1A2230)
private val Accent = Color(0xFF5BF7AC)
private val AccentDim = Color(0xFF12CE8C)
private val TextPrimary = Color(0xFFE8EEF6)
private val TextSecondary = Color(0xFF8B98A9)
private val Danger = Color(0xFFFF6B6B)

private val ZharnessDark = darkColorScheme(
	primary = Accent,
	onPrimary = Color(0xFF06251A),
	secondary = AccentDim,
	background = Background,
	onBackground = TextPrimary,
	surface = Surface,
	onSurface = TextPrimary,
	surfaceVariant = SurfaceHigh,
	onSurfaceVariant = TextSecondary,
	error = Danger,
	outline = Color(0xFF2A3547),
)

@Composable
fun ZharnessTheme(content: @Composable () -> Unit) {
	// The app is dark-first, matching the desktop aesthetic.
	isSystemInDarkTheme()
	MaterialTheme(colorScheme = ZharnessDark, content = content)
}
