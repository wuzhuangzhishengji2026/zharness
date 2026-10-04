package com.zharness.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Widgets
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
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.data.protocol.ModelInfoDto
import com.zharness.mobile.ui.screens.ChatScreen
import com.zharness.mobile.ui.screens.ExtensionsScreen
import com.zharness.mobile.ui.screens.ProviderConfigScreen
import com.zharness.mobile.ui.screens.ReplayScreen
import com.zharness.mobile.ui.screens.ScheduleScreen
import com.zharness.mobile.ui.screens.SessionsScreen
import com.zharness.mobile.ui.screens.ServersScreen
import com.zharness.mobile.ui.screens.SkillsScreen
import com.zharness.mobile.ui.screens.SkinPetScreen
import com.zharness.mobile.ui.screens.SopScreen
import com.zharness.mobile.ui.screens.TimelineScreen
import com.zharness.mobile.ui.screens.ToolboxScreen

/** Toolbox 二级页路由（AppRoot 内部导航状态）。 */
enum class Overlay {
	NONE, PROVIDERS, SESSIONS, SCHEDULE, SOP, SKILLS, EXTENSIONS, SKINPET, REPLAY,
}

private fun overlayTitle(overlay: Overlay): String = when (overlay) {
	Overlay.PROVIDERS -> "模型服务配置"
	Overlay.SESSIONS -> "会话与分支"
	Overlay.SCHEDULE -> "计划任务"
	Overlay.SOP -> "SOP 市场"
	Overlay.SKILLS -> "技能"
	Overlay.EXTENSIONS -> "扩展"
	Overlay.SKINPET -> "皮肤与宠物"
	Overlay.REPLAY -> "回放"
	Overlay.NONE -> ""
}

/**
 * Root shell: server picker when unpaired; otherwise a bottom-tab workspace
 * (chat / timeline / toolbox / servers) with full-screen overlay pages that
 * carry their own back header and honor the system back gesture. All engine
 * state lives in the process-level EngineHub, so this composable is a pure
 * projection.
 */
@Composable
fun AppRoot(
	initialShare: String? = null,
	initialPairUri: String? = null,
	vm: AppViewModel = viewModel(),
) {
	val ui by vm.ui.collectAsState()
	var overlay by remember { mutableStateOf(Overlay.NONE) }
	BackHandler(enabled = overlay != Overlay.NONE) { overlay = Overlay.NONE }

	LaunchedEffect(initialShare) {
		if (initialShare != null) vm.setPendingShare(initialShare)
	}
	LaunchedEffect(initialPairUri) {
		if (initialPairUri != null) vm.setPendingPairUri(initialPairUri)
	}

	Surface(
		modifier = Modifier.fillMaxSize().statusBarsPadding(),
		color = MaterialTheme.colorScheme.background,
	) {
		if (ui.activeProfile == null) {
			ServersScreen(vm)
		} else if (overlay != Overlay.NONE) {
			Column(modifier = Modifier.fillMaxSize()) {
				OverlayHeader(title = overlayTitle(overlay), onBack = { overlay = Overlay.NONE })
				Box(modifier = Modifier.fillMaxSize()) {
					when (overlay) {
						Overlay.PROVIDERS -> ProviderConfigScreen(vm, onClose = { overlay = Overlay.NONE })
						Overlay.SESSIONS -> SessionsScreen(vm, ui)
						Overlay.SCHEDULE -> ScheduleScreen(vm, ui)
						Overlay.SOP -> SopScreen(vm, ui)
						Overlay.SKILLS -> SkillsScreen(vm, ui)
						Overlay.EXTENSIONS -> ExtensionsScreen(vm, ui)
						Overlay.SKINPET -> SkinPetScreen(vm, ui)
						Overlay.REPLAY -> ReplayScreen(vm, ui)
						Overlay.NONE -> {}
					}
				}
			}
		} else {
			Column(modifier = Modifier.fillMaxSize()) {
				WorkspaceHeader(
					ui,
					onModelPicked = vm::setModel,
					onDisconnect = vm::disconnect,
					onOpenProviders = { overlay = Overlay.PROVIDERS },
					onOpenSessions = { overlay = Overlay.SESSIONS },
				)
				Box(modifier = Modifier.weight(1f)) {
					when (ui.selectedTab) {
						Tab.CHAT -> ChatScreen(vm, ui)
						Tab.TIMELINE -> TimelineScreen(ui)
						Tab.TOOLBOX -> ToolboxScreen(vm, onOpen = { route ->
							overlay = when (route) {
								"schedule" -> Overlay.SCHEDULE
								"sop" -> Overlay.SOP
								"skills" -> Overlay.SKILLS
								"extensions" -> Overlay.EXTENSIONS
								"skinpet" -> Overlay.SKINPET
								"replay" -> Overlay.REPLAY
								else -> Overlay.NONE
							}
						})
						Tab.SERVERS -> ServersScreen(vm, embedded = true)
					}
				}
				BottomTabs(ui.selectedTab, onSelect = vm::selectTab)
			}
		}
	}
}

/** 二级页统一返回栏：返回箭头 + 标题，配 BackHandler 接管系统返回键。 */
@Composable
private fun OverlayHeader(title: String, onBack: () -> Unit) {
	Row(
		modifier = Modifier
			.fillMaxWidth()
			.background(MaterialTheme.colorScheme.surface)
			.padding(horizontal = 4.dp, vertical = 2.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		IconButton(onClick = onBack) {
			Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
		}
		Text(title, style = MaterialTheme.typography.titleMedium)
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
						Tab.TOOLBOX -> Icon(Icons.Filled.Widgets, contentDescription = tab.label)
						Tab.SERVERS -> Icon(Icons.Filled.Dns, contentDescription = tab.label)
					}
				},
				label = { Text(tab.label) },
			)
		}
	}
}

/** 状态点 + 工作区信息 + 会话/密钥/模型/断开（图标按钮，窄屏不拥挤）。 */
@Composable
private fun WorkspaceHeader(
	ui: EngineHub.UiState,
	onModelPicked: (ModelInfoDto) -> Unit,
	onDisconnect: () -> Unit,
	onOpenProviders: () -> Unit,
	onOpenSessions: () -> Unit,
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
				text = listOfNotNull(
					ui.currentModel,
					ui.thinkingLevel?.let { "thinking:$it" },
					if (ui.safeMode) "安全模式" else null,
				).joinToString(" · ").ifEmpty { "未连接" },
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 1,
			)
		}
		IconButton(onClick = onOpenSessions) {
			Icon(Icons.AutoMirrored.Filled.ListAlt, contentDescription = "会话与分支")
		}
		IconButton(onClick = onOpenProviders) {
			Icon(Icons.Filled.Key, contentDescription = "模型服务密钥")
		}
		IconButton(onClick = { modelsMenu = true }) {
			Icon(Icons.Filled.Tune, contentDescription = "切换模型")
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
			Icon(Icons.Filled.LinkOff, contentDescription = "断开连接")
		}
	}
}
