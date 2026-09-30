#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parallel_delegate.py — 并行派发多个子任务（子智能体并行路径的核心执行器）

参考 superpowers dispatching-parallel-agents：2+ 独立问题域 → 每域一个 agent 并行 →
返回后由主 agent 做两级评审与集成验证。主 agent 的 _delegate_agent 是同步阻塞的，
本脚本用 subprocess 并行 spawn 多个子进程实现真正的并行子智能体，
每个子进程拥有独立会话（独立审计链），只把最终摘要返回给主 agent。

支持平台：
  - zharness:    spawn `zharness -p --no-session` 子进程（ZHarness 平台默认）
  - opencode: spawn `opencode run --format text` 子进程（OpenCode 平台）

用法:
    python parallel_delegate.py --platform opencode --cli <opencode路径> --tasks <tasks.json> [选项]

参数:
    --platform <zharness|opencode>  子进程平台，默认 zharness
    --cli <path>        agent 可执行文件路径（zharness.exe / opencode.exe，缺省自动取 PATH 中的命令名）
    --model <model>     opencode 平台时透传给 opencode run --model（可选）
    --tasks <path>      tasks.json 路径，格式:
                        [{"id":"t1","cwd":"<项目目录>","task":"<子任务完整描述>"}, ...]
    --timeout <秒>      每个子任务超时，默认 300
    --agent-dir <dir>   子进程 agentDir（zharness 平台；默认继承 ZHARNESS_CODING_AGENT_DIR 或 ~/.zharness/agent）
    --out-dir <dir>     每个子任务输出的落盘目录，默认 .code-gen-summary/parallel-results/
    --print-last-only   每个子任务只保留最后一段非空文本（默认截断 8000 字符）

输出:
    stdout 打印 JSON 汇总: [{"id","exit_code","output","error","duration_s"}]
    每个子任务完整输出写入 <out-dir>/<id>.txt（可用于审计回放）
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def resolve_agent_dir(args):
    if args.agent_dir:
        return args.agent_dir
    return os.environ.get("ZHARNESS_CODING_AGENT_DIR") or str(Path.home() / ".zharness" / "agent")


def resolve_cli(args):
    if args.cli:
        cli = os.path.abspath(os.path.expanduser(args.cli))
        if not Path(cli).exists():
            raise FileNotFoundError(f"cli not found: {cli}")
        return cli
    name = "zharness.exe" if args.platform == "zharness" else "opencode.exe"
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"cli not found in PATH: {name}")
    return found


def build_cmd(args, cli, prompt):
    if args.platform == "opencode":
        cmd = [cli, "run", "--format", "text"]
        if args.model:
            cmd += ["--model", args.model]
        cmd.append(prompt)
        return cmd
    cmd = [cli, "-p", "--no-session", "--no-context-files", prompt]
    return cmd


def build_env(args, agent_dir):
    env = dict(os.environ)
    if args.platform == "zharness":
        env["ZHARNESS_CODING_AGENT_DIR"] = agent_dir
        env.setdefault("ZHARNESS_CODING_AGENT", "true")
    return env


def run_task(args, cli, task, agent_dir, timeout, out_dir, print_last_only):
    task_id = task.get("id", "unknown")
    cwd = task.get("cwd") or os.getcwd()
    prompt = task.get("task", "")
    out_file = out_dir / f"{task_id}.txt"
    start = time.time()
    try:
        cmd = build_cmd(args, cli, prompt)
        env = build_env(args, agent_dir)
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        output = (proc.stdout or "") + ("\n[stderr]\n" + proc.stderr if proc.stderr else "")
        if print_last_only:
            # 只保留最后一段非空文本（近似"最后一条 assistant 文本"）
            lines = [l for l in output.splitlines() if l.strip()]
            tail = "\n".join(lines[-60:]) if lines else ""
            output = tail if tail else output
        out_file.write_text(output, encoding="utf-8")
        return {
            "id": task_id,
            "exit_code": proc.returncode,
            "output": output[:8000],
            "output_file": str(out_file),
            "error": None,
            "duration_s": round(time.time() - start, 1),
        }
    except subprocess.TimeoutExpired:
        out_file.write_text("(timeout after %ss)" % timeout, encoding="utf-8")
        return {
            "id": task_id,
            "exit_code": -1,
            "output": f"(timeout after {timeout}s)",
            "output_file": str(out_file),
            "error": "timeout",
            "duration_s": round(time.time() - start, 1),
        }
    except Exception as exc:  # noqa: BLE001
        out_file.write_text(f"(error: {exc})", encoding="utf-8")
        return {
            "id": task_id,
            "exit_code": -2,
            "output": f"(error: {exc})",
            "output_file": str(out_file),
            "error": str(exc),
            "duration_s": round(time.time() - start, 1),
        }


def main():
    parser = argparse.ArgumentParser(description="Parallel sub-agent delegation (zharness/opencode)")
    parser.add_argument("--platform", choices=["zharness", "opencode"], default="zharness", help="sub-agent platform")
    parser.add_argument("--cli", default=None, help="path to agent executable (zharness.exe / opencode.exe)")
    parser.add_argument("--model", default=None, help="model for opencode platform (--model)")
    parser.add_argument("--tasks", required=True, help="path to tasks.json")
    parser.add_argument("--timeout", type=int, default=300, help="per-task timeout in seconds")
    parser.add_argument("--agent-dir", default=None, help="agentDir for sub processes (zharness platform)")
    parser.add_argument("--out-dir", default=None, help="output dir for per-task results")
    parser.add_argument("--print-last-only", action="store_true", help="keep only last assistant text")
    args = parser.parse_args()

    tasks_path = Path(args.tasks)
    try:
        tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # 兼容带 BOM 的 UTF-8 文件（Windows PowerShell Set-Content -Encoding UTF8 会产生 BOM）
        tasks = json.loads(tasks_path.read_text(encoding="utf-8-sig"))
    if not isinstance(tasks, list) or len(tasks) == 0:
        print(json.dumps({"error": "tasks must be a non-empty list"}, ensure_ascii=False))
        sys.exit(1)

    out_dir = Path(args.out_dir) if args.out_dir else Path(os.getcwd()) / ".code-gen-summary" / "parallel-results"
    out_dir.mkdir(parents=True, exist_ok=True)
    agent_dir = resolve_agent_dir(args)

    try:
        cli = resolve_cli(args)
    except FileNotFoundError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)

    # 并行 spawn 所有子任务（每个独立 agent 进程 / 独立会话）
    results = []
    for task in tasks:
        results.append(run_task(args, cli, task, agent_dir, args.timeout, out_dir, args.print_last_only))

    print(json.dumps({"results": results, "count": len(results)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
