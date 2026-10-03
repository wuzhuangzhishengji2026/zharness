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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.zharness.mobile.ui.AppViewModel

/** 本机模式默认参数（引擎跑在手机 Termux 里，监听 loopback）。 */
private const val LOCAL_HOST = "127.0.0.1"
private const val LOCAL_PORT = "8787"
private const val LOCAL_ONE_LINER =
	"pkg install -y wget && wget -O termux-install.sh https://raw.githubusercontent.com/wuzhuangzhishengji2026/zharness/main/scripts/termux-install.sh && bash termux-install.sh"

/**
 * Server picker + pairing form. The host runs `zharness serve`, which prints
 * a one-time pairing code; the phone pairs once and keeps its device token.
 */
@Composable
fun ServersScreen(vm: AppViewModel, embedded: Boolean = false) {
	val ui = vm.ui.collectAsState().value

	var address by remember { mutableStateOf("") }
	var port by remember { mutableStateOf("") }
	var code by remember { mutableStateOf("") }
	var deviceName by remember { mutableStateOf("") }
	var showLocalGuide by remember { mutableStateOf(false) }

	LaunchedEffect(ui.pendingPairUri) {
		val uri = ui.pendingPairUri
		if (uri != null) {
			address = uri
			runCatching {
				val parsed = android.net.Uri.parse(uri)
				port = parsed.getQueryParameter("port") ?: ""
				parsed.getQueryParameter("code")?.let { code = it }
			}
			vm.consumePendingPairUri()
		}
	}

	Column(
		modifier = Modifier
			.fillMaxSize()
			.verticalScroll(rememberScrollState())
			.padding(16.dp),
		verticalArrangement = Arrangement.spacedBy(10.dp),
	) {
		Text("连接到 zharness serve", style = MaterialTheme.typography.titleLarge)

		// ── 本机模式：引擎跑在这台手机的 Termux 里，无需电脑 ──
		Card(modifier = Modifier.fillMaxWidth()) {
			Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
				Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					Icon(Icons.Filled.PhoneAndroid, contentDescription = null,
						tint = MaterialTheme.colorScheme.primary)
					Text("本机模式（无需电脑）", style = MaterialTheme.typography.titleSmall)
				}
				Text(
					text = "引擎直接跑在这台手机的 Termux 里，App 连接 127.0.0.1。" +
						"需要先在 Termux 中完成一次安装（联网下载约 300MB）。",
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					OutlinedButton(onClick = {
						address = LOCAL_HOST
						port = LOCAL_PORT
					}) { Text("一键填入本机地址") }
					TextButton(onClick = { showLocalGuide = true }) { Text("安装教程") }
				}
			}
		}

		HorizontalDivider()
		Text("远程模式（电脑端 serve）", style = MaterialTheme.typography.titleMedium)
		Text(
			text = "在电脑上运行：zharness serve，控制台会输出一次性配对码。" +
				"也可以把 zharness://pair?… 链接直接粘贴进地址框。",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)

		OutlinedTextField(
			value = address,
			onValueChange = { address = it },
			label = { Text("地址或 zharness://pair 链接") },
			placeholder = { Text("192.168.1.10 或 zharness://pair?host=…") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth(),
		)
		Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			OutlinedTextField(
				value = port,
				onValueChange = { port = it.filter { c -> c.isDigit() } },
				label = { Text("端口") },
				placeholder = { Text("serve 控制台输出") },
				singleLine = true,
				modifier = Modifier.weight(1f),
			)
			OutlinedTextField(
				value = code,
				onValueChange = { code = it.filter { c -> c.isDigit() }.take(6) },
				label = { Text("配对码") },
				singleLine = true,
				modifier = Modifier.weight(1f),
			)
		}
		OutlinedTextField(
			value = deviceName,
			onValueChange = { deviceName = it },
			label = { Text("设备名称（可选）") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth(),
		)
		Button(
			onClick = { vm.pairAndConnect(address, port, code, deviceName) },
			enabled = address.isNotBlank() && ui.busy == null,
			modifier = Modifier.fillMaxWidth(),
		) {
			Text(if (ui.busy != null) ui.busy!! else "配对并连接")
		}

		ui.error?.let { error ->
			Card(modifier = Modifier.fillMaxWidth()) {
				Row(
					modifier = Modifier.padding(12.dp),
					horizontalArrangement = Arrangement.spacedBy(8.dp),
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
		}

		if (ui.profiles.isNotEmpty()) {
			HorizontalDivider()
			Text("已配对的服务器", style = MaterialTheme.typography.titleMedium)
			ui.profiles.reversed().forEach { profile ->
				Card(modifier = Modifier.fillMaxWidth()) {
					Row(
						modifier = Modifier.padding(12.dp),
						horizontalArrangement = Arrangement.spacedBy(8.dp),
					) {
						Column(modifier = Modifier.weight(1f)) {
							Text(profile.name, style = MaterialTheme.typography.titleSmall)
							Text(
								text = listOfNotNull(
									"${profile.host}:${profile.port}",
									profile.workspace,
									if (profile.token != null) "已配对" else "无凭据",
								).joinToString(" · "),
								style = MaterialTheme.typography.bodySmall,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
						TextButton(onClick = { vm.connect(profile) }) { Text("连接") }
						IconButton(onClick = { vm.deleteProfile(profile.id) }) {
							Icon(Icons.Filled.Delete, contentDescription = "删除")
						}
					}
				}
			}
		}

		Text(
			text = "安全提示：设备 token 只保存在本机；模型 API 密钥始终留在引擎侧。" +
				"远程模式跨公网建议 Tailscale/WireGuard；本机模式不出网络，天然安全。",
			style = MaterialTheme.typography.bodySmall,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
		)
	}

	if (showLocalGuide) {
		AlertDialog(
			onDismissRequest = { showLocalGuide = false },
			title = { Text("本机模式安装（Termux）") },
			text = {
				Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
					Text("1. 从 F-Droid 安装 Termux", style = MaterialTheme.typography.bodyMedium)
					Text("2. 在 Termux 里执行下面的命令（联网下载约 300MB，包含 Node 与编译工具链）：",
						style = MaterialTheme.typography.bodyMedium)
					Text(
						LOCAL_ONE_LINER,
						style = MaterialTheme.typography.bodySmall,
						fontFamily = FontFamily.Monospace,
					)
					Text("3. 安装完成引擎自动启动，控制台显示 6 位配对码；" +
						"回到本 App 点「一键填入本机地址」，把配对码填入即可。",
						style = MaterialTheme.typography.bodyMedium)
					Text("提示：模型 API 配置存放在手机的 ~/.zharness/，" +
						"与电脑端互不相通；锁屏后安卓可能冻结后台，长任务请保持 Termux 前台。",
						style = MaterialTheme.typography.bodySmall,
						color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			},
			confirmButton = {
				TextButton(onClick = { showLocalGuide = false }) { Text("知道了") }
			},
		)
	}
}
