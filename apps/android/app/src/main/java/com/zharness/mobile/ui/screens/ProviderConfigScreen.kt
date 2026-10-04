package com.zharness.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zharness.mobile.ui.AppViewModel

private data class ProviderGroup(
	val provider: String,
	val models: List<String>,
	val hasAuth: Boolean,
)

/**
 * Provider API key configuration. Keys are sent once over the authenticated
 * channel and persisted to the ENGINE's auth.json (Termux in local mode, the
 * host in remote mode) — the phone never stores them.
 */
@Composable
fun ProviderConfigScreen(vm: AppViewModel, onClose: () -> Unit) {
		// onClose kept for API symmetry; the shared overlay header handles back.
	val ui = vm.ui.collectAsState().value

	// Group available models by provider; hasAuth reflects the engine side.
	val groups = remember(ui.models) {
		ui.models
			.groupBy { it.provider ?: "未知" }
			.map { (provider, models) ->
				ProviderGroup(
					provider = provider,
					models = models.map { it.name ?: it.id },
					hasAuth = models.any { it.hasAuth },
				)
			}
			.sortedBy { it.hasAuth } // unconfigured providers first
	}

	Column(modifier = Modifier.fillMaxSize()) {
		Text(
			text = "密钥保存在引擎侧（本机模式即手机 Termux），App 不存储",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.padding(horizontal = 14.dp),
		)
		Column(
			modifier = Modifier
				.fillMaxSize()
				.verticalScroll(rememberScrollState())
				.padding(14.dp),
			verticalArrangement = Arrangement.spacedBy(10.dp),
		) {
			if (ui.models.isEmpty()) {
				Text(
					text = if (ui.connected) "引擎未返回可用模型" else "未连接",
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			groups.forEach { group ->
				var key by remember(group.provider) { mutableStateOf("") }
				Card(modifier = Modifier.fillMaxWidth()) {
					Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
						Row(
							modifier = Modifier.fillMaxWidth(),
							horizontalArrangement = Arrangement.SpaceBetween,
						) {
							Text(group.provider, style = MaterialTheme.typography.titleSmall)
							Text(
								text = if (group.hasAuth) "✓ 已配置" else "未配置",
								style = MaterialTheme.typography.labelSmall,
								color = if (group.hasAuth) MaterialTheme.colorScheme.primary
								else MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
						Text(
							text = group.models.take(4).joinToString("、") +
								if (group.models.size > 4) " 等 ${group.models.size} 个模型" else "",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
						if (!group.hasAuth) {
							OutlinedTextField(
								value = key,
								onValueChange = { key = it },
								label = { Text("${group.provider} 的 API Key") },
								singleLine = true,
								visualTransformation = PasswordVisualTransformation(),
								modifier = Modifier.fillMaxWidth(),
							)
							Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
								Button(
									onClick = {
										vm.setApiKey(group.provider, key)
										key = ""
									},
									enabled = key.isNotBlank() && ui.busy == null,
								) { Text(if (ui.busy != null) ui.busy!! else "保存") }
								if (group.hasAuth) {
									TextButton(onClick = { vm.removeApiKey(group.provider) }) { Text("移除") }
								}
							}
						} else {
							TextButton(onClick = { vm.removeApiKey(group.provider) }) { Text("移除此服务的密钥") }
						}
					}
				}
			}
			ui.error?.let { error ->
				Text(
					text = error,
					color = MaterialTheme.colorScheme.error,
					style = MaterialTheme.typography.bodySmall,
				)
				TextButton(onClick = vm::dismissError) { Text("知道了") }
			}
			Text(
				text = "常见 provider：zai（GLM）、deepseek、moonshotai、openai、anthropic。" +
					"保存后无需重启引擎，回到对话即可使用。",
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}
