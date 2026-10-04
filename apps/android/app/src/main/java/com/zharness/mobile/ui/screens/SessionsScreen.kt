package com.zharness.mobile.ui.screens

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.zharness.mobile.ui.AppViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 会话列表 + 分支树。点卡片切换会话；左上「新会话」；分支树里点「分叉」
 * 从任意历史会话长出新分支（git-log 式记忆的移动端入口）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionsScreen(vm: AppViewModel, ui: AppViewModel.UiState) {
	var showBranches by remember { mutableStateOf(false) }

	LaunchedEffect(showBranches) {
		if (showBranches) vm.loadHistory() else vm.loadSessions()
	}

	Column(modifier = Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		Row(
			modifier = Modifier.fillMaxWidth(),
			horizontalArrangement = Arrangement.SpaceBetween,
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text(
				if (showBranches) "分支树（点「分叉」从历史长出新分支）" else "会话列表",
				style = MaterialTheme.typography.titleMedium,
			)
			TextButton(onClick = { showBranches = !showBranches }) {
				Text(if (showBranches) "看会话" else "看分支树")
			}
		}
		if (!showBranches) {
			TextButton(onClick = { vm.newSession() }) { Text("＋ 新会话") }
		}
		if (showBranches) {
			LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				items(ui.history.size) { index ->
					val node = ui.history.sortedBy { it.depth }[index]
					Card(modifier = Modifier.fillMaxWidth()) {
						Row(
							modifier = Modifier
								.fillMaxWidth()
								.combinedClickable(
									onClick = { vm.switchSession(node.sessionId) },
									onLongClick = { vm.forkSession(node.sessionId) },
								)
								.padding(12.dp)
								.padding(start = ((node.depth * 14).toInt()).dp),
							verticalAlignment = Alignment.CenterVertically,
						) {
							Column(modifier = Modifier.weight(1f)) {
								Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
									Text(node.name, style = MaterialTheme.typography.titleSmall)
									if (node.isActive) Badge { Text("当前") }
								}
								node.snippet?.takeIf { it.isNotBlank() }?.let {
									Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
								}
							}
							TextButton(onClick = { vm.forkSession(node.sessionId) }) { Text("分叉") }
						}
					}
				}
			}
		} else {
			LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				items(ui.sessions.size) { index ->
					val session = ui.sessions[index]
					Card(
						onClick = { vm.switchSession(session.sessionId) },
						modifier = Modifier.fillMaxWidth(),
					) {
						Column(modifier = Modifier.padding(12.dp)) {
							Text(session.title, style = MaterialTheme.typography.titleSmall, maxLines = 1)
							session.createdAt?.let {
								Text(
									DATE_FORMAT.format(Date(it)),
									style = MaterialTheme.typography.bodySmall,
									color = MaterialTheme.colorScheme.onSurfaceVariant,
								)
							}
						}
					}
				}
			}
		}
	}
}

private val DATE_FORMAT = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
