package com.zharness.mobile.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.zharness.mobile.data.protocol.TimelineEvent
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.ui.AppViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val FILTERS = listOf("全部", "USER_MESSAGE", "AGENT_MESSAGE", "TOOL_EXECUTION", "SESSION", "其他")

private fun matchesFilter(type: String, filter: String): Boolean = when (filter) {
	"全部" -> true
	"AGENT_MESSAGE" -> type.startsWith("AGENT_MESSAGE") || type.startsWith("AGENT_THINKING")
	"TOOL_EXECUTION" -> type.startsWith("TOOL_") ||
		type == "FILE_MUTATION_APPLIED" ||
		type == "COMMAND_EXECUTED"
	"SESSION" -> type.startsWith("SESSION_") || type.startsWith("TASK_") ||
		type.startsWith("GOAL_") || type.startsWith("COMPACTION_")
	"其他" -> !matchesFilter(type, "USER_MESSAGE") &&
		!matchesFilter(type, "AGENT_MESSAGE") &&
		!matchesFilter(type, "TOOL_EXECUTION") &&
		!matchesFilter(type, "SESSION")
	else -> type.startsWith(filter)
}

/**
 * Timeline — newest-first live view of the append-only event log. Every row
 * is one event; the log itself stays on the host, this is a projection.
 */
@Composable
fun TimelineScreen(ui: EngineHub.UiState) {
	var filter by remember { mutableStateOf("全部") }
	val visible = ui.events.filter { matchesFilter(it.type, filter) }.asReversed()

	Column(modifier = Modifier.fillMaxSize()) {
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.horizontalScroll(rememberScrollState())
				.padding(horizontal = 12.dp, vertical = 6.dp),
			horizontalArrangement = Arrangement.spacedBy(6.dp),
		) {
			FILTERS.forEach { candidate ->
				FilterChip(
					selected = filter == candidate,
					onClick = { filter = candidate },
					label = { Text(candidate) },
				)
			}
		}
		HorizontalDivider()
		if (visible.isEmpty()) {
			Text(
				text = if (ui.connected) "暂无事件——日志会随会话实时追加" else "未连接",
				style = MaterialTheme.typography.bodyMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				modifier = Modifier.padding(16.dp),
			)
			return@Column
		}
		// Positional items on purpose: eventIds can repeat between the resync
		// snapshot and the live stream before the cursor reconciles them.
		LazyColumn(modifier = Modifier.fillMaxSize()) {
			items(visible.size) { index ->
				EventRow(visible[index])
				HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
			}
		}
	}
}

@Composable
private fun EventRow(event: TimelineEvent) {
	Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp)) {
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			Text(
				text = event.type,
				style = MaterialTheme.typography.labelMedium,
				color = MaterialTheme.colorScheme.primary,
			)
			event.sequence?.let { seq ->
				Text(
					text = "seq $seq",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			event.timestamp?.let { ts ->
				Text(
					text = TIME_FORMAT.format(Date(ts)),
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
		}
		if (event.summary.isNotBlank()) {
			Text(
				text = event.summary.take(200),
				style = MaterialTheme.typography.bodySmall,
				fontFamily = FontFamily.Monospace,
				maxLines = 3,
			)
		}
	}
}

private val TIME_FORMAT = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
