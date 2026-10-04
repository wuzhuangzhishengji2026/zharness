package com.zharness.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.zharness.mobile.ui.AppViewModel

/**
 * 皮肤与宠物：应用主题皮肤（引擎侧投影生效）、盲盒孵化宠物、喂食/玩耍互动。
 */
@Composable
fun SkinPetScreen(vm: AppViewModel, ui: AppViewModel.UiState) {
	LaunchedEffect(Unit) {
		vm.loadSkins()
		vm.loadPet()
	}
	Column(
		modifier = Modifier
			.fillMaxSize()
			.verticalScroll(rememberScrollState())
			.padding(14.dp),
		verticalArrangement = Arrangement.spacedBy(10.dp),
	) {
		Text("宠物", style = MaterialTheme.typography.titleMedium)
		val pet = ui.pet
		if (pet == null) {
			Card(modifier = Modifier.fillMaxWidth()) {
				Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
					Text("还没有宠物——开一个盲盒吧", color = MaterialTheme.colorScheme.onSurfaceVariant)
					Button(onClick = { vm.hatchPet() }, enabled = ui.busy == null) { Text("孵化盲盒 🥚") }
				}
			}
		} else {
			Card(modifier = Modifier.fillMaxWidth()) {
				Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
					Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
						Text(pet.emoji, style = MaterialTheme.typography.headlineMedium)
						Column {
							Text("${pet.name} · ${pet.species}", style = MaterialTheme.typography.titleSmall)
							pet.personality?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
						}
					}
					pet.blurb?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2) }
					StatRow("心情", pet.mood)
					StatRow("精力", pet.energy)
					StatRow("羁绊", pet.bond)
					Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
						OutlinedButton(onClick = { vm.interactPet("feed", pet.id) }) { Text("喂食 🍖") }
						OutlinedButton(onClick = { vm.interactPet("play", pet.id) }) { Text("玩耍 🎾") }
					}
				}
			}
		}

		HorizontalDivider()
		Text("皮肤（应用到引擎端投影）", style = MaterialTheme.typography.titleMedium)
		if (ui.skins.isEmpty()) {
			Text("未取到皮肤列表", color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		ui.skins.forEach { skin ->
			Card(modifier = Modifier.fillMaxWidth()) {
				Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
					Column(modifier = Modifier.weight(1f)) {
						Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
							Text(skin.name, style = MaterialTheme.typography.titleSmall)
							if (skin.active) Text("✓ 使用中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
						}
						skin.description?.let {
							Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
						}
					}
					if (!skin.active) {
						OutlinedButton(onClick = { vm.applySkin(skin.id) }) { Text("应用") }
					}
				}
			}
		}
	}
}

@Composable
private fun StatRow(label: String, value: Long) {
	Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
		Text(label, style = MaterialTheme.typography.bodySmall)
		Text("$value", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
	}
}
