// 动态任务工作流：任意任务进来，先规划拆解，再按依赖分波并行执行，
// 逐项独立复核（未通过修复一轮），最后汇总报告。
// 脚本本身不绑定任何项目：浏览文件、运行命令都由子代理用自己的工具完成，
// 因此可以在任何工作区运行。facade 由引擎注入，不需要 import。

interface SubTask {
	/** 子任务短 id，如 "t1"、"t2"，在计划内唯一 */
	id: string;
	/** 一句话说清这个子任务做什么 */
	title: string;
	/** 具体要求与验收标准：范围、边界、做到什么程度算完成，尽量具体到文件路径或命令 */
	detail: string;
	/** 必须先完成的子任务 id 列表（引用其他子任务的 id）；没有依赖就给空数组 */
	dependsOn: string[];
}

interface Plan {
	/** 两三句话：对这个任务的理解和总体执行思路 */
	understanding: string;
	/** 是否应继续执行；任务无法安全进行（破坏性操作、缺外部凭据、明显超出能力）时给 false */
	proceed: boolean;
	/** 拆出的子任务，1 到 6 个；简单任务 1 个即可 */
	subtasks: SubTask[];
}

interface SubTaskOutcome {
	/** 对应的子任务 id */
	id: string;
	/** 是否按要求完成了这个子任务 */
	ok: boolean;
	/** 三句以内：做了什么、结论是什么；若产出是答案，这里给出答案核心 */
	summary: string;
	/** 证据：改动/创建了哪些文件、运行了哪些命令、结果如何 */
	evidence: string;
	/** 产出或改动的文件（工作区相对路径），没有就给空数组 */
	deliverables: string[];
}

interface Review {
	/** 复核结论：confirmed=声明属实；refuted=发现与声明不符；unclear=无法核实 */
	verdict: "confirmed" | "refuted" | "unclear";
	/** 一句话：核实了什么、依据是什么，或哪里与声明不符 */
	note: string;
}

interface Reviewed {
	/** 子任务 id（以计划中的 id 为准，不取执行者自报的） */
	id: string;
	/** 最终采纳的执行结果（复核未通过且修复过时是修复后的结果） */
	outcome: SubTaskOutcome;
	/** verified=独立复核确认；unconfirmed=复核未确认（含修复后仍未确认） */
	status: "verified" | "unconfirmed";
	/** 复核结论一句话 */
	note: string;
}

interface Finding {
	/** 子任务 id 及其涉及的主要文件 */
	where: string;
	/** 一句话：这个子任务做成了什么，或留下了什么问题 */
	what: string;
	/** 依据：执行者给出的证据 + 独立复核的结论 */
	evidence: string;
	/** verified=独立复核确认；unconfirmed=未经复核确认（含失败与跳过） */
	status: "verified" | "unconfirmed";
	/** 成功完成即 low；未完成或被跳过为 medium；全部子任务失败（任务未达成）为 high */
	severity: "low" | "medium" | "high";
}

interface WorkflowReport {
	/** 两三句话回答：任务完成得怎么样 */
	conclusion: string;
	/** 每个子任务一条结果 */
	findings: Finding[];
	/** 本次运行实际做了哪些核验 */
	verified: string[];
	/** 没覆盖或无法核验的部分及原因 */
	notCovered: string[];
}

function outcomeOf(list: SubTaskOutcome[], id: string): SubTaskOutcome {
	const hit = list.find((o) => o.id === id);
	return hit ?? { id, ok: false, summary: "（无结果）", evidence: "", deliverables: [] };
}

function taskOf(list: SubTask[], id: string): SubTask {
	const hit = list.find((t) => t.id === id);
	return hit ?? { id, title: id, detail: "", dependsOn: [] };
}

/** 按依赖分波：每一波内的子任务相互独立，可并行执行。 */
function wavesOf(subtasks: SubTask[]): SubTask[][] {
	const done = new Set<string>();
	const waves: SubTask[][] = [];
	let remaining = [...subtasks];
	while (remaining.length > 0) {
		const wave = remaining.filter((t) => t.dependsOn.every((d) => done.has(d)));
		if (wave.length === 0) {
			// 依赖成环或引用了不存在的 id：剩下的作为最后一波硬执行，不静默丢弃。
			waves.push(remaining);
			break;
		}
		waves.push(wave);
		for (const t of wave) done.add(t.id);
		remaining = remaining.filter((t) => !done.has(t.id));
	}
	return waves;
}

const task = String(args.task ?? "").trim();
const constraints = String(args.constraints ?? "").trim();

if (!task) {
	const empty: WorkflowReport = {
		conclusion: "没有提供任务描述（task 参数为空），未执行任何工作。",
		findings: [],
		verified: [],
		notCovered: ["全部 —— 缺少任务描述"],
	};
	return empty;
}

const constraintLine = constraints ? `\n【附加约束】${constraints}` : "";

phase("按工作区现场拆解任务");
log(`任务：${task}`);
const plan = await agent(
	"规划员",
	"你是任务规划员：先浏览工作区现场再拆解，拆出的子任务必须可独立验收、粒度均衡、依赖最少。",
).ask<Plan>(
	[
		`【任务】${task}${constraintLine}`,
		"",
		"请先了解工作区现场（目录结构、关键文件、已有的验证命令），然后把这个任务拆解成带依赖的子任务计划。",
		"拆解原则：1 到 6 个子任务；每个子任务一句话目标 + 具体到文件/命令的验收标准；确实有先后依赖才写 dependsOn，否则并行。",
		"任务无法安全进行（破坏性操作、缺凭据、明显超出能力）时 proceed 给 false 并在 understanding 里说明原因。",
	].join("\n"),
	{ of: "Plan" },
);

if (!plan.proceed) {
	const refused: WorkflowReport = {
		conclusion: `规划员建议不要继续执行：${plan.understanding}`,
		findings: [],
		verified: [],
		notCovered: ["全部 —— 规划阶段判定任务不应执行"],
	};
	return refused;
}

const subtasks = plan.subtasks;
log(`计划 ${subtasks.length} 个子任务：${subtasks.map((t) => `${t.id}(${t.title})`).join("、")}`);
const waves = wavesOf(subtasks);
const allReviewed: Reviewed[] = [];

// 同波并行：每个子任务的「执行 → 独立复核 →（修复 → 复检）」在各自回调里
// 完成，只在波与波之间汇合（下一波依赖上一波的结果）。
phase("按依赖分波并行执行子任务");
for (let w = 0; w < waves.length; w++) {
	const wave = waves[w];
	log(`第 ${w + 1}/${waves.length} 波：${wave.map((t) => t.title).join("、")}`);
	const reviewedInWave = await Promise.all(
		wave.map(async (t) => {
			const outcome = await agent(
				`执行-${t.id}`,
				"你是子任务执行员：动手完成分配给你的子任务，用工具读文件、改文件、跑命令，最后如实汇报。",
			).ask<SubTaskOutcome>(
				[
					`【子任务 ${t.id}】${t.title}`,
					`【要求】${t.detail}`,
					`【任务背景】${plan.understanding}${constraintLine}`,
					"",
					"完成这个子任务（可以也只可以为本任务必要的改动），然后按结果契约汇报。",
					"没做到就如实 ok=false 并说明卡在哪里，不要谎报。",
				].join("\n"),
				{ of: "SubTaskOutcome" },
			);

			const reviewPrompt = (target: SubTaskOutcome): string =>
				[
					`【待复核的子任务 ${t.id}】${t.title}`,
					`【要求】${t.detail}`,
					`【执行者声明】${JSON.stringify(target)}`,
					"",
					"请独立核实这份声明：自己打开它声称改过的文件、自己跑它声称跑过的命令，不要采信执行者的转述。",
					"声明与现场一致给 confirmed；发现不符（文件没改/命令没跑/结论站不住）给 refuted 并指出具体哪里不符；",
					"无法核实的部分给 unclear 并说明缺什么。不要修改任何文件。",
				].join("\n");

			const firstReview = await agent(
				`复核-${t.id}`,
				"你是独立复核员：只核实、不修改。从证据现场自己验证执行者的声明，宁可 unclear 也不放过不符。",
			).ask<Review>(reviewPrompt(outcome), { of: "Review" });

			let final = outcome;
			let status: "verified" | "unconfirmed" = "unconfirmed";
			let note = firstReview.note;

			if (firstReview.verdict === "confirmed") {
				status = "verified";
			} else if (firstReview.verdict === "refuted") {
				const repaired = await agent(
					`修复-${t.id}`,
					"你是子任务执行员：上一轮成果未通过独立复核，请针对性修复后重新汇报。",
				).ask<SubTaskOutcome>(
					[
						`【子任务 ${t.id}】${t.title}`,
						`【要求】${t.detail}`,
						`【上一轮结果】${JSON.stringify(outcome)}`,
						`【复核指出的问题】${firstReview.note}`,
						"",
						"请修复复核指出的问题，然后按结果契约重新汇报完整结果。",
					].join("\n"),
					{ of: "SubTaskOutcome" },
				);
				const recheck = await agent(
					`复检-${t.id}`,
					"你是独立复核员：只核实、不修改。这是修复后的第二轮复核，同样要从证据现场自己验证。",
				).ask<Review>(reviewPrompt(repaired), { of: "Review" });
				final = repaired;
				if (recheck.verdict === "confirmed") {
					status = "verified";
					note = `${firstReview.note}；修复后复检通过`;
				} else {
					note = `${firstReview.note}；修复后仍未确认（${recheck.note}）`;
				}
			}

			const reviewed: Reviewed = { id: t.id, outcome: final, status, note };
			report(reviewed, "progress");
			return reviewed;
		}),
	);
	allReviewed.push(...reviewedInWave);
}

phase("汇总并交付任务执行报告");
const outcomes = allReviewed.map((r) => r.outcome);
const findings: Finding[] = allReviewed.map((r) => {
	const t = taskOf(subtasks, r.id);
	const ok = r.outcome.ok && r.status === "verified";
	return {
		where: `${r.id}（${t.title}${r.outcome.deliverables.length ? "：" + r.outcome.deliverables.join("、") : ""}）`,
		what: ok ? r.outcome.summary : `${r.outcome.summary}（未获独立复核确认）`,
		evidence: `${r.outcome.evidence}｜复核：${r.note}`,
		status: r.status,
		severity: ok ? "low" : r.outcome.ok ? "medium" : "medium",
	};
});
const okCount = allReviewed.filter((r) => r.outcome.ok && r.status === "verified").length;
const doneCount = allReviewed.filter((r) => r.outcome.ok).length;
const allFailed = doneCount === 0;

const reportMd = [
	`# 动态任务工作流报告`,
	"",
	`- 任务：${task}`,
	`- 计划：${plan.understanding}`,
	`- 结果：${okCount}/${allReviewed.length} 个子任务完成并通过独立复核（${doneCount}/${allReviewed.length} 自报完成）`,
	"",
	"## 子任务明细",
	"",
	...allReviewed.map((r) => {
		const t = taskOf(subtasks, r.id);
		const flag = r.status === "verified" ? "✅" : "⚠️";
		return [
			`### ${flag} ${r.id} ${t.title}（${r.status === "verified" ? "已核实" : "未确认"}）`,
			"",
			`- 结果：${r.outcome.summary}`,
			`- 证据：${r.outcome.evidence || "（无）"}`,
			r.outcome.deliverables.length ? `- 产出文件：${r.outcome.deliverables.join("、")}` : "",
			`- 复核：${r.note}`,
			"",
		]
			.filter(Boolean)
			.join("\n");
	}),
	"## 复核说明",
	"",
	`每个子任务由独立复核员从工作区现场核实执行者的声明；未通过者自动修复一轮后换人复检，仍未通过则保留结果并标注 unconfirmed。`,
	"",
].join("\n");

await artifact.markdown("report", reportMd, {
	title: "任务执行报告",
	description: `${okCount}/${allReviewed.length} 个子任务完成并通过独立复核`,
	primary: true,
});

const result: WorkflowReport = {
	conclusion: allFailed
		? `任务未达成：${allReviewed.length} 个子任务全部失败，详见报告。`
		: okCount === allReviewed.length
			? `任务完成：${allReviewed.length} 个子任务全部完成并通过独立复核。`
			: `任务部分完成：${okCount}/${allReviewed.length} 个子任务完成并通过独立复核，其余见报告中的未确认项。`,
	findings,
	verified: [
		`每个子任务均由独立复核员核实（${allReviewed.filter((r) => r.status === "verified").length} 个通过）`,
		...outcomes.flatMap((o) => o.deliverables),
	],
	notCovered: allReviewed.filter((r) => r.status !== "verified").map((r) => `${r.id}：${r.note}`),
};
return result;
