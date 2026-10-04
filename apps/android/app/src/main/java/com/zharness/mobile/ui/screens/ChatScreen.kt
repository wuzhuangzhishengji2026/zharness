package com.zharness.mobile.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import com.zharness.mobile.data.protocol.ChatMessage
import com.zharness.mobile.data.EngineHub
import com.zharness.mobile.ui.AppViewModel

/**
 * Conversation view — messages are a projection of the event log, streamed
 * live via AGENT_MESSAGE_CHUNK and reconciled from get_messages at turn
 * boundaries. Safe-mode approval cards appear above the composer.
 */
@Composable
fun ChatScreen(vm: AppViewModel, ui: EngineHub.UiState) {
	var draft by remember { mutableStateOf("") }
	val listState = rememberLazyListState()
	val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
		uri?.let { vm.attachImage(it) }
	}

	// Share-to-agent: pre-fill the composer once per incoming share.
	LaunchedEffect(ui.pendingShare) {
		if (ui.pendingShare != null) {
			draft = ui.pendingShare
			vm.consumePendingShare()
		}
	}

	LaunchedEffect(ui.messages.size, ui.streamText) {
		val target = ui.messages.size + if (ui.streamText.isNotEmpty()) 1 else 0
		if (target > 0) listState.animateScrollToItem(target - 1)
	}

	Column(modifier = Modifier.fillMaxSize().imePadding()) {
		// Engine errors (e.g. provider without an API key) surface here instead
		// of vanishing into the timeline.
		ui.error?.let { error ->
			Row(
				modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text(
					text = error,
					color = MaterialTheme.colorScheme.error,
					style = MaterialTheme.typography.bodySmall,
					modifier = Modifier.weight(1f),
				)
				TextButton(onClick = vm::dismissError) { Text("知道了") }
			}
		}

		// Safe-mode approval cards: engine is paused waiting for a decision.
		if (ui.pendingApprovals.isNotEmpty()) {
			Card(
				modifier = Modifier
					.fillMaxWidth()
					.padding(horizontal = 12.dp, vertical = 4.dp),
			) {
				Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
					Row(
						modifier = Modifier.fillMaxWidth(),
						horizontalArrangement = Arrangement.SpaceBetween,
						verticalAlignment = Alignment.CenterVertically,
					) {
						Text("安全模式 · 等待审批", style = MaterialTheme.typography.titleSmall)
						Switch(checked = ui.safeMode, onCheckedChange = { vm.toggleSafeMode() })
					}
					ui.pendingApprovals.take(3).forEach { approval ->
						Column {
							Text("🔧 ${approval.toolName}", style = MaterialTheme.typography.titleSmall)
							Text(
								approval.argumentsSummary.take(160),
								style = MaterialTheme.typography.bodySmall,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
								maxLines = 2,
							)
							Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
								Button(onClick = { vm.approve(approval.eventId) }) { Text("允许") }
								OutlinedButton(onClick = { vm.reject(approval.eventId) }) { Text("拒绝") }
							}
						}
					}
					if (ui.pendingApprovals.size > 3) {
						Text("…另有 ${ui.pendingApprovals.size - 3} 个待审批", style = MaterialTheme.typography.bodySmall)
					}
				}
			}
		}

		Box(modifier = Modifier.weight(1f)) {
			LazyColumn(
				state = listState,
				modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, alignment = Alignment.Top),
			) {
				if (ui.messages.isEmpty() && ui.streamText.isEmpty()) {
					item {
						Text(
							text = "连接已建立。这里是事件日志的最新投影——发送一条消息开始，任何历史都可以在「会话 → 分支树」里分叉。",
							style = MaterialTheme.typography.bodyMedium,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
							modifier = Modifier.padding(vertical = 24.dp),
						)
					}
				}
				items(ui.messages.size) { index ->
					MessageBubble(ui.messages[index])
				}
				if (ui.streamText.isNotEmpty()) {
					item { MessageBubble(ChatMessage("assistant", ui.streamText), streaming = true) }
				}
			}
		}
		Composer(
			draft = draft,
			onDraftChange = { draft = it },
			busy = ui.isStreaming,
			enabled = ui.connected,
			imageCount = ui.attachedImages.size,
			onPickImage = { imagePicker.launch("image/*") },
			onClearImages = vm::clearAttachedImages,
			onSend = {
				vm.sendPrompt(draft, ui.attachedImages)
				vm.clearAttachedImages()
				draft = ""
			},
			onAbort = vm::abort,
		)
	}
}

@Composable
private fun MessageBubble(message: ChatMessage, streaming: Boolean = false) {
	val isUser = message.role == "user"
	Row(
		modifier = Modifier.fillMaxWidth(),
		horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
	) {
		Surface(
			color = if (isUser) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface,
			shape = RoundedCornerShape(
				topStart = 14.dp,
				topEnd = 14.dp,
				bottomStart = if (isUser) 14.dp else 3.dp,
				bottomEnd = if (isUser) 3.dp else 14.dp,
			),
			modifier = Modifier.widthIn(max = 340.dp),
		) {
			Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
				if (!isUser) {
					Text(
						text = if (streaming) "agent …" else "agent",
						style = MaterialTheme.typography.labelSmall,
						color = MaterialTheme.colorScheme.primary,
					)
				}
				Text(
					text = message.text.ifBlank { "（非文本内容）" },
					style = MaterialTheme.typography.bodyMedium,
				)
			}
		}
	}
}

@Composable
private fun Composer(
	draft: String,
	onDraftChange: (String) -> Unit,
	busy: Boolean,
	enabled: Boolean,
	imageCount: Int,
	onPickImage: () -> Unit,
	onClearImages: () -> Unit,
	onSend: () -> Unit,
	onAbort: () -> Unit,
) {
	Column(modifier = Modifier.background(MaterialTheme.colorScheme.surface)) {
		if (imageCount > 0) {
			Row(
				modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
				horizontalArrangement = Arrangement.SpaceBetween,
				verticalAlignment = Alignment.CenterVertically,
			) {
				Text("已附加 $imageCount 张图片", style = MaterialTheme.typography.bodySmall)
				TextButton(onClick = onClearImages) { Text("移除") }
			}
		}
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.padding(horizontal = 10.dp, vertical = 8.dp),
			verticalAlignment = Alignment.Bottom,
			horizontalArrangement = Arrangement.spacedBy(6.dp),
		) {
			IconButton(onClick = onPickImage, enabled = enabled) {
				Icon(Icons.Filled.AddAPhoto, contentDescription = "附加图片")
			}
			OutlinedTextField(
				value = draft,
				onValueChange = onDraftChange,
				modifier = Modifier.weight(1f),
				placeholder = { Text(if (enabled) "给 Agent 发消息…" else "未连接") },
				enabled = enabled,
				maxLines = 5,
				shape = RoundedCornerShape(14.dp),
			)
			IconButton(onClick = if (busy) onAbort else onSend, enabled = enabled && (draft.isNotBlank() || imageCount > 0 || busy)) {
				if (busy) {
					Icon(Icons.Filled.Stop, contentDescription = "中止", tint = MaterialTheme.colorScheme.error)
				} else {
					Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
				}
			}
		}
	}
}
