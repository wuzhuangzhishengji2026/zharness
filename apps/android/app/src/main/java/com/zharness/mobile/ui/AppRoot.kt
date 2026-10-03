package com.zharness.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zharness.mobile.data.protocol.ModelInfoDto
import com.zharness.mobile.ui.screens.ChatScreen
import com.zharness.mobile.ui.screens.ServersScreen
import com.zharness.mobile.ui.screens.TimelineScreen

enum class Tab(val label: String) {
	CHAT("对话"),
	TIMELINE("时间线"),
	SERVERS("服务器"),
}

/**
 * Root shell: server picker when unpaired, otherwise a bottom-tab workspace
 * (chat / timeline / servers). The ViewModel is scoped to the activity, so a
 * reconnect on rotation costs nothing.
 */
@Composable
fun AppRoot(
	initialShare: String? = null,
	initialPairUri: String? = null,
	vm: AppViewModel = viewModel(),
) {
	val ui by vm.ui.collectAsState()

	LaunchedEffect(initialShare) {
		if (initialShare != null) vm.setPendingShare(initialShare)
	}
	LaunchedEffect(initialPairUri) {
		if (initialPairUri != null) vm.setPendingPairUri(initialPairUri)
	}

	Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
		if (ui.activeProfile == null) {
			ServersScreen(vm)
		} else {
			Column(modifier = Modifier.fillMaxSize()) {
				WorkspaceHeader(ui, onModelPicked = vm::setModel, onDisconnect = vm::disconnect)
				Box(modifier = Modifier.weight(1f)) {
					when (ui.selectedTab) {
						Tab.CHAT -> ChatScreen(vm, ui)
						Tab.TIMELINE -> TimelineScreen(ui)
						Tab.SERVERS -> ServersScreen(vm, embedded = true)
					}
				}
				BottomTabs(ui.selectedTab, onSelect = vm::selectTab)
			}
		}
	}
}

@Composable
private fun BottomTabs(current: Tab, onSelect: (Tab) -> Unit) {
	NavigationBar {
		Tab.entries.forEach { tab ->
			NavigationBarItem(
				selected = tab == current,
				onClick = { onSelect(tab) },
				icon = {
					when (tab) {
						Tab.CHAT -> Icon(Icons.Filled.ChatBubble, contentDescription = tab.label)
						Tab.TIMELINE -> Icon(Icons.Filled.AccountTree, contentDescription = tab.label)
						Tab.SERVERS -> Icon(Icons.Filled.Dns, contentDescription = tab.label)
					}
				},
				label = { Text(tab.label) },
			)
		}
	}
}

/** Status dot + workspace + model/thinking pickers + disconnect. */
@Composable
private fun WorkspaceHeader(
	ui: AppViewModel.UiState,
	onModelPicked: (ModelInfoDto) -> Unit,
	onDisconnect: () -> Unit,
) {
	var modelsMenu by remember { mutableStateOf(false) }
	Row(
		modifier = Modifier
			.fillMaxWidth()
			.background(MaterialTheme.colorScheme.surface)
			.padding(horizontal = 14.dp, vertical = 10.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(10.dp),
	) {
		Box(
			modifier = Modifier
				.size(10.dp)
				.background(
					color = when {
						ui.connected -> MaterialTheme.colorScheme.primary
						ui.connecting -> MaterialTheme.colorScheme.onSurfaceVariant
						else -> MaterialTheme.colorScheme.error
					},
					shape = CircleShape,
				),
		)
		Column(modifier = Modifier.weight(1f)) {
			Text(
				text = ui.workspaceName ?: ui.activeProfile?.name ?: "ZHarness",
				style = MaterialTheme.typography.titleMedium,
				maxLines = 1,
			)
			Text(
				text = listOfNotNull(ui.currentModel, ui.thinkingLevel?.let { "thinking:$it" })
					.joinToString(" · ")
					.ifEmpty { "未连接" },
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 1,
			)
		}
		IconButton(onClick = { modelsMenu = true }) {
			Text(text = "模型", style = MaterialTheme.typography.labelLarge)
		}
		DropdownMenu(expanded = modelsMenu, onDismissRequest = { modelsMenu = false }) {
			if (ui.models.isEmpty()) {
				DropdownMenuItem(text = { Text("无可用模型") }, onClick = { modelsMenu = false })
			}
			ui.models.forEach { model ->
				DropdownMenuItem(
					text = {
						Text(
							text = buildString {
								append(model.name ?: model.id)
								if (!model.hasAuth) append("（未配置密钥）")
							},
						)
					},
					onClick = {
						modelsMenu = false
						if (model.hasAuth) onModelPicked(model)
					},
				)
			}
		}
		IconButton(onClick = onDisconnect) {
			Text(text = "断开", style = MaterialTheme.typography.labelLarge)
		}
	}
}
