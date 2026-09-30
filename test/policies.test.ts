/**
 * Reactor policy tests.
 */

import { describe, expect, it } from "vitest";
import { DefaultRetryPolicy } from "../src/core/runtime/policies.js";

describe("DefaultRetryPolicy", () => {
	const policy = new DefaultRetryPolicy();

	it("retries transient provider errors", () => {
		expect(policy.isRetryable({ message: "Provider returned error: 503 service unavailable" })).toBe(true);
		expect(policy.isRetryable({ message: "fetch failed" })).toBe(true);
		expect(policy.isRetryable({ message: "overloaded" })).toBe(true);
		expect(policy.isRetryable({ message: "whatever", statusCode: 429 })).toBe(true);
	});

	it("never retries malformed-request 400s (InvalidParameter/BadRequest)", () => {
		// 火山/DashScope 的 400 经 pi-ai 包装;同样的请求重试只会原样再失败,
		// 每次失败还把错误消息累积进上下文(回合中跳转后的孤儿 toolResult 雪崩)。
		expect(
			policy.isRetryable({
				message: 'Provider returned error: 400 {"code":"InvalidParameter","type":"BadRequest"}',
			}),
		).toBe(false);
		expect(policy.isRetryable({ message: "400 bad request: unknown parameter" })).toBe(false);
		// 429 是限流不是参数错误,仍要重试。
		expect(policy.isRetryable({ message: "Provider returned error: 429 rate limit" })).toBe(true);
	});
});
