/**
 * 宠物插件的数据层（GUI 面）。
 *
 * 数据由内置扩展 `pets` 提供（src/builtin-extensions/pets）：
 * - 档案与互动经 `pet_*` RPC 读写；
 * - 变更经 CUSTOM_MESSAGE(display:false, kind=pets_changed) 广播，收到后重拉；
 * - 盲盒结果（RpcHatchResult）含种族/稀有度/闪光原始抽取，供开箱动画展示。
 *
 * 与 lib/skins.ts 同模式：RPC 做数据面，事件做刷新提示。
 */

import { sendCommandAwait, subscribeEvents } from "./transport";
import type {
	RpcHatchResult,
	RpcPet,
	RpcPetInteractResult,
	RpcPetsState,
} from "./types";

const EMPTY_STATE: RpcPetsState = { pets: [], activePetView: null, totalHatched: 0 };

/** 拉取宠物档案（失败返回空态，挂件降级隐藏）。 */
export async function fetchPetsState(): Promise<RpcPetsState> {
	try {
		const r = await sendCommandAwait<RpcPetsState>({ type: "pet_state" }, 10000);
		const data = r.data;
		if (!data || !Array.isArray(data.pets)) return EMPTY_STATE;
		return {
			pets: data.pets,
			activePetId: typeof data.activePetId === "string" ? data.activePetId : undefined,
			activePetView: data.activePetView ?? null,
			totalHatched: typeof data.totalHatched === "number" ? data.totalHatched : 0,
		};
	} catch {
		return EMPTY_STATE;
	}
}

/** 开一次盲盒。 */
export async function hatchPetRpc(): Promise<RpcHatchResult | null> {
	const r = await sendCommandAwait<RpcHatchResult>({ type: "pet_hatch" }, 10000);
	return r.data ?? null;
}

/** 喂食 / 玩耍。 */
export async function interactPetRpc(
	action: "feed" | "play",
	petId: string,
): Promise<RpcPetInteractResult | null> {
	const r = await sendCommandAwait<RpcPetInteractResult>({ type: "pet_interact", action, petId }, 10000);
	return r.data ?? null;
}

export async function renamePetRpc(petId: string, name: string): Promise<RpcPet | null> {
	const r = await sendCommandAwait<{ pet: RpcPet | null }>({ type: "pet_rename", petId, name }, 10000);
	return r.data?.pet ?? null;
}

export async function carryPetRpc(petId: string): Promise<RpcPet | null> {
	const r = await sendCommandAwait<{ pet: RpcPet | null }>({ type: "pet_carry", petId }, 10000);
	return r.data?.pet ?? null;
}

export async function releasePetRpc(petId: string): Promise<boolean> {
	const r = await sendCommandAwait<{ released: boolean }>({ type: "pet_release", petId }, 10000);
	return r.data?.released ?? false;
}

/** 订阅宠物变更（扩展广播）。返回退订函数。 */
export function subscribePetsChanges(handler: () => void): () => void {
	let unlisten: (() => void) | undefined;
	void subscribeEvents((event) => {
		if (event.type !== "CUSTOM_MESSAGE") return;
		const payload = event.payload as { kind?: unknown; extension_id?: unknown } | undefined;
		if (payload?.extension_id === "pets" && payload?.kind === "pets_changed") {
			handler();
		}
	}).then((fn) => {
		unlisten = fn;
	});
	return () => unlisten?.();
}
