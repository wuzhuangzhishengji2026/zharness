package com.zharness.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.ui.AppViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 回放：选一个历史会话，把事件日志当录像逐帧回看。可见事件与噪音事件
 * 已在 VM 过滤（REPLAY_VISIBLE）。
 */
@Composable
fun ReplayScreen(vm: AppViewModel, ui: EngineHub.UiState) {
	LaunchedEffect(Unit) { vm.loadReplayList() }

	Column(modifier = Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		if (ui.replayEvents.isEmpty()) {
			Text("选择一个会话开始回放", style = MaterialTheme.typography.titleMedium)
			if (ui.replaySessions.isEmpty()) {
				Text("暂无回放会话", color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
			LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				items(ui.replaySessions.size) { index ->
					val session = ui.replaySessions[index]
					Card(
						onClick = { vm.startReplay(session.id) },
						modifier = Modifier.fillMaxWidth(),
					) {
						Column(modifier = Modifier.padding(12.dp)) {
							Text(session.name, style = MaterialTheme.typography.titleSmall, maxLines = 1)
							session.description?.let {
								Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
							}
						}
					}
				}
			}
		} else {
			Row(
				modifier = Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.SpaceBetween,
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text("回放中", style = MaterialTheme.typography.titleMedium)
				TextButton(onClick = { vm.replayExit() }) { Text("← 换会话") }
			}
			val current = ui.replayEvents.getOrNull(ui.replayIndex)
			Card(modifier = Modifier.fillMaxWidth()) {
				Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
					Text(
						text = current?.type ?: "（开头）",
						style = MaterialTheme.typography.titleMedium,
						color = MaterialTheme.colorScheme.primary,
					)
					current?.timestamp?.let {
						Text(TIME_FORMAT.format(Date(it)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					current?.summary?.takeIf { it.isNotBlank() }?.let {
						Text(it.take(400), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 8)
					}
				}
			}
			Slider(
				value = ui.replayIndex.toFloat().coerceAtLeast(0f),
				onValueChange = { vm.replaySeek(it.toInt()) },
				valueRange = 0f..(ui.replayEvents.size - 1).toFloat().coerceAtLeast(0f),
			)
			Row(
				modifier = Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.SpaceBetween,
				verticalAlignment = Alignment.CenterVertically,
			) {
				TextButton(onClick = { vm.replaySeek(ui.replayIndex - 1) }) { Text("◀ 上一帧") }
				Text("${(ui.replayIndex + 1).coerceAtLeast(1)}/${ui.replayEvents.size}", style = MaterialTheme.typography.labelMedium)
				TextButton(onClick = { vm.replayTogglePlay() }) { Text(if (ui.replayPlaying) "⏸ 暂停" else "▶ 自动播放") }
				TextButton(onClick = { vm.replaySeek(ui.replayIndex + 1) }) { Text("下一帧 ▶") }
			}
		}
	}
}

private val TIME_FORMAT = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
