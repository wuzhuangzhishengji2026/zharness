package com.zharness.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import com.zharness.mobile.data.protocol.NamedEntry
import com.zharness.mobile.data.protocol.ScheduleTask
import com.zharness.mobile.ui.AppViewModel

/**
 * 工具箱首页：计划任务 / SOP 市场 / 技能 / 扩展的入口网格。
 */
@Composable
fun ToolboxScreen(vm: AppViewModel, onOpen: (String) -> Unit) {
	val entries = listOf(
		"schedule" to ("计划任务" to "定时把消息派发给引擎"),
		"sop" to ("SOP 市场" to "code-review / deep-research 等工作流"),
		"skills" to ("技能" to "已安装的斜杠技能"),
		"extensions" to ("扩展" to "内置与用户扩展的启停"),
		"skinpet" to ("皮肤与宠物" to "主题皮肤 / 盲盒宠物互动"),
		"replay" to ("回放" to "把历史会话当录像回看"),
	)
	LazyVerticalGrid(
		columns = GridCells.Fixed(2),
		modifier = Modifier.fillMaxSize().padding(12.dp),
		horizontalArrangement = Arrangement.spacedBy(10.dp),
		verticalArrangement = Arrangement.spacedBy(10.dp),
	) {
		items(entries.size) { index ->
			val (route, label) = entries[index]
			Card(
				onClick = { onOpen(route) },
				modifier = Modifier.fillMaxWidth(),
			) {
				Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
					Text(label.first, style = MaterialTheme.typography.titleMedium)
					Text(
						label.second,
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
		}
	}
}

// ============================================================================
// 计划任务
// ============================================================================

@Composable
fun ScheduleScreen(vm: AppViewModel, ui: AppViewModel.UiState) {
	var name by remember { mutableStateOf("") }
	var prompt by remember { mutableStateOf("") }
	var hour by remember { mutableStateOf("9") }
	var minute by remember { mutableStateOf("0") }

	LaunchedEffect(Unit) { vm.loadSchedules() }

	Column(modifier = Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		Text("新建每日任务", style = MaterialTheme.typography.titleSmall)
		OutlinedTextField(
			value = name, onValueChange = { name = it },
			label = { Text("任务名") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
		)
		OutlinedTextField(
			value = prompt, onValueChange = { prompt = it },
			label = { Text("派发给引擎的消息") }, modifier = Modifier.fillMaxWidth(),
		)
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
			OutlinedTextField(
				value = hour, onValueChange = { hour = it.filter { c -> c.isDigit() }.take(2) },
				label = { Text("时") }, singleLine = true, modifier = Modifier.weight(1f),
			)
			OutlinedTextField(
				value = minute, onValueChange = { minute = it.filter { c -> c.isDigit() }.take(2) },
				label = { Text("分") }, singleLine = true, modifier = Modifier.weight(1f),
			)
			Button(
				onClick = { vm.createSchedule(name, prompt, (hour.toIntOrNull() ?: 9) % 24, (minute.toIntOrNull() ?: 0) % 60); name = ""; prompt = "" },
				enabled = name.isNotBlank() && prompt.isNotBlank(),
			) { Text("创建") }
		}
		HorizontalDivider()
		if (ui.schedules.isEmpty()) {
			Text("暂无计划任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
			items(ui.schedules, key = { it.id }) { task ->
				ScheduleRow(vm, task)
			}
		}
	}
}

@Composable
private fun ScheduleRow(vm: AppViewModel, task: ScheduleTask) {
	Card(modifier = Modifier.fillMaxWidth()) {
		Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
			Column(modifier = Modifier.weight(1f)) {
				Text(task.name, style = MaterialTheme.typography.titleSmall)
				Text(
					text = "${task.scheduleSummary} · 已跑 ${task.runCount} 次" +
						(task.lastRunStatus?.let { " · 上次:$it" } ?: ""),
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				if (task.prompt.isNotBlank()) {
					Text(
						task.prompt.take(80),
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
					)
				}
			}
			Switch(checked = task.enabled, onCheckedChange = { vm.toggleSchedule(task) })
		}
		Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
			TextButton(onClick = { vm.runScheduleNow(task) }) { Text("立即运行") }
			TextButton(onClick = { vm.deleteSchedule(task) }) { Text("删除", color = MaterialTheme.colorScheme.error) }
		}
	}
}

// ============================================================================
// SOP 市场 / 技能 / 扩展 —— 通用列表渲染
// ============================================================================

@Composable
fun SopScreen(vm: AppViewModel, ui: AppViewModel.UiState) {
	LaunchedEffect(Unit) { vm.loadSops() }
	EntryListScreen(
		entries = ui.sops,
		emptyText = "市场为空（SOP 模板随引擎内置）",
		installedLabel = { "已安装 · 点卸载" },
		notInstalledLabel = { "安装" },
		onInstall = { vm.installSop(it) },
		onUninstall = { vm.uninstallSop(it) },
	)
}

@Composable
fun SkillsScreen(vm: AppViewModel, ui: AppViewModel.UiState) {
	LaunchedEffect(Unit) { vm.loadSkills() }
	var source by remember { mutableStateOf("") }
	var slug by remember { mutableStateOf("") }
	Column(modifier = Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		Text("从 GitHub 安装技能（owner/repo 格式）", style = MaterialTheme.typography.titleSmall)
		Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			OutlinedTextField(
				value = source, onValueChange = { source = it },
				label = { Text("来源 owner/repo") }, singleLine = true, modifier = Modifier.weight(1f),
			)
			OutlinedTextField(
				value = slug, onValueChange = { slug = it },
				label = { Text("slug") }, singleLine = true, modifier = Modifier.weight(1f),
			)
			OutlinedButton(
				onClick = { vm.installSkill(source, slug); slug = "" },
				enabled = source.contains("/") && slug.isNotBlank(),
			) { Text("安装") }
		}
		HorizontalDivider()
		EntryListContent(
			entries = ui.skills,
			emptyText = "尚未安装任何技能",
			installedLabel = { "已安装" },
			notInstalledLabel = { "安装" },
			onInstall = { vm.installSkill("builtin", it) },
			onUninstall = null,
		)
	}
}

@Composable
fun ExtensionsScreen(vm: AppViewModel, ui: AppViewModel.UiState) {
	LaunchedEffect(Unit) { vm.loadExtensions() }
	Column(modifier = Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
		Text("扩展启停立即生效；带外部依赖的扩展可安装/卸载其依赖", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		EntryListContent(
			entries = ui.extensions,
			emptyText = "未加载任何扩展",
			installedLabel = { "启用中" },
			notInstalledLabel = { "已停用" },
			onInstall = null,
			onUninstall = null,
			trailingToggle = { entry ->
				if (entry.canToggle == true) {
					Switch(checked = entry.enabled == true, onCheckedChange = { vm.toggleExtension(entry.id, it) })
				}
			},
		)
	}
}

// ============================================================================
// 通用条目列表（技能 / SOP / 扩展共用）
// ============================================================================

@Composable
fun EntryListScreen(
	entries: List<NamedEntry>,
	emptyText: String,
	installedLabel: (NamedEntry) -> String,
	notInstalledLabel: (NamedEntry) -> String,
	onInstall: ((String) -> Unit)?,
	onUninstall: ((String) -> Unit)?,
) {
	Column(modifier = Modifier.fillMaxSize().padding(14.dp)) {
		EntryListContent(entries, emptyText, installedLabel, notInstalledLabel, onInstall, onUninstall)
	}
}

@Composable
fun EntryListContent(
	entries: List<NamedEntry>,
	emptyText: String,
	installedLabel: (NamedEntry) -> String,
	notInstalledLabel: (NamedEntry) -> String,
	onInstall: ((String) -> Unit)?,
	onUninstall: ((String) -> Unit)?,
	trailingToggle: (@Composable (NamedEntry) -> Unit)? = null,
	) {
		if (entries.isEmpty()) {
			Text(emptyText, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
			return
		}
		LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
			items(entries, key = { it.id }) { entry ->
				Card(modifier = Modifier.fillMaxWidth()) {
					Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
						Column(modifier = Modifier.weight(1f)) {
							Text(entry.name, style = MaterialTheme.typography.titleSmall)
							entry.description?.takeIf { it.isNotBlank() }?.let {
								Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
							}
						}
						if (entry.installed) {
							Text(installedLabel(entry), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
							if (onUninstall != null) {
								TextButton(onClick = { onUninstall(entry.id) }) { Text("卸载") }
							}
						} else if (onInstall != null) {
							Button(onClick = { onInstall(entry.id) }) { Text(notInstalledLabel(entry)) }
						}
						trailingToggle?.invoke(entry)
					}
				}
			}
		}
	}
