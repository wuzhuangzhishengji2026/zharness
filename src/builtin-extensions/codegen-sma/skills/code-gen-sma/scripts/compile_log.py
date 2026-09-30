#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compile_log.py — 本地编译日志记录工具（stage4-compile 配套）

作用：
    将每次编译的关键信息（命令、退出码、stdout/stderr、错误分类、重试次数、
    语言、构建系统、同步状态等）以 JSON Lines 形式追加写入本地日志文件，
    便于事后审计、回放与统计分析。

日志位置：
    <project_root>/.code-gen-summary/compile-log/compile-log.jsonl
    每条记录一行 JSON，便于 grep / jq / pandas 等工具处理。

用法（三种模式）：

1) 追加一条编译记录（推荐由 stage4 Agent 调用）：
    python compile_log.py append \
        --project-root <项目根目录> \
        --language <cpp|java> \
        --build-system <makefile|cmake|qmake|meson|maven|gradle|javac> \
        --command "<完整编译命令>" \
        --exit-code <整数> \
        --stdout "<stdout 内容或文件路径>" \
        --stderr "<stderr 内容或文件路径>" \
        --sync-status <success|failed|skipped> \
        --retry-count <整数> \
        --max-retry <整数> \
        --errors-file <错误分类 JSON 文件路径，可选> \
        --session-id <stage4 会话标识，可选>

2) 查询最近 N 条记录：
    python compile_log.py query --project-root <项目根目录> --limit 10

3) 统计成功/失败次数：
    python compile_log.py stats --project-root <项目根目录>

输出：
    append  → stdout 打印写入的记录 JSON（含 _id 与 _logfile）
    query   → stdout 打印 JSON 数组
    stats   → stdout 打印 {"total": N, "success": X, "failed": Y, "success_rate": Z}
"""

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path


LOG_DIR_NAME = "compile-log"
LOG_FILE_NAME = "compile-log.jsonl"


def resolve_log_path(project_root: str) -> Path:
    log_dir = Path(project_root) / ".code-gen-summary" / LOG_DIR_NAME
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / LOG_FILE_NAME


def read_text_arg(value):
    """允许 --stdout/--stderr 直接传文本，或传 @file 路径读取文件内容。"""
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith("@"):
        file_path = value[1:]
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except (OSError, IOError):
            return ""
    return value


def load_errors_file(path):
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, IOError, json.JSONDecodeError):
        return []


def cmd_append(args):
    log_path = resolve_log_path(args.project_root)
    record = {
        "_id": uuid.uuid4().hex,
        "_logfile": str(log_path),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "epoch": int(time.time()),
        "session_id": args.session_id or "",
        "language": args.language,
        "build_system": args.build_system,
        "remote": args.remote,
        "sync_status": args.sync_status or "skipped",
        "command": args.command or "",
        "exit_code": args.exit_code if args.exit_code is not None else -1,
        "retry_count": args.retry_count if args.retry_count is not None else 0,
        "max_retry": args.max_retry if args.max_retry is not None else 3,
        "stdout": read_text_arg(args.stdout),
        "stderr": read_text_arg(args.stderr),
        "errors": load_errors_file(args.errors_file),
        "success": (args.exit_code == 0) if args.exit_code is not None else False,
    }

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


def cmd_query(args):
    log_path = resolve_log_path(args.project_root)
    if not log_path.exists():
        print(json.dumps([], ensure_ascii=False))
        return 0

    records = []
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if args.success_only:
        records = [r for r in records if r.get("success")]
    if args.failed_only:
        records = [r for r in records if not r.get("success")]
    if args.language:
        records = [r for r in records if r.get("language") == args.language]

    records = records[-args.limit:] if args.limit > 0 else records
    print(json.dumps(records, ensure_ascii=False, indent=2))
    return 0


def cmd_stats(args):
    log_path = resolve_log_path(args.project_root)
    if not log_path.exists():
        print(json.dumps({"total": 0, "success": 0, "failed": 0, "success_rate": 0.0}))
        return 0

    total = success = failed = 0
    by_language = {}
    by_build_system = {}

    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            total += 1
            lang = r.get("language", "unknown")
            bs = r.get("build_system", "unknown")
            by_language[lang] = by_language.get(lang, 0) + 1
            by_build_system[bs] = by_build_system.get(bs, 0) + 1
            if r.get("success"):
                success += 1
            else:
                failed += 1

    rate = (success / total) if total > 0 else 0.0
    out = {
        "total": total,
        "success": success,
        "failed": failed,
        "success_rate": round(rate, 4),
        "by_language": by_language,
        "by_build_system": by_build_system,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        description="Local compile log recorder for stage4-compile"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_append = sub.add_parser("append", help="append a compile record")
    p_append.add_argument("--project-root", required=True, help="项目根目录")
    p_append.add_argument("--language", required=True, choices=["cpp", "c", "java"])
    p_append.add_argument("--build-system", required=True,
                          choices=["makefile", "cmake", "qmake", "meson",
                                   "maven", "gradle", "javac"])
    p_append.add_argument("--remote", action="store_true", help="是否远程编译")
    p_append.add_argument("--sync-status", default="skipped",
                          choices=["success", "failed", "skipped"])
    p_append.add_argument("--command", default="", help="完整编译命令")
    p_append.add_argument("--exit-code", type=int, default=None)
    p_append.add_argument("--retry-count", type=int, default=0)
    p_append.add_argument("--max-retry", type=int, default=3)
    p_append.add_argument("--stdout", default="", help="stdout 文本或 @文件路径")
    p_append.add_argument("--stderr", default="", help="stderr 文本或 @文件路径")
    p_append.add_argument("--errors-file", default="",
                          help="错误分类 JSON 文件路径（可选）")
    p_append.add_argument("--session-id", default="", help="stage4 会话标识（可选）")
    p_append.set_defaults(func=cmd_append)

    p_query = sub.add_parser("query", help="query recent records")
    p_query.add_argument("--project-root", required=True)
    p_query.add_argument("--limit", type=int, default=10)
    p_query.add_argument("--language", default="", choices=["", "cpp", "c", "java"])
    p_query.add_argument("--success-only", action="store_true")
    p_query.add_argument("--failed-only", action="store_true")
    p_query.set_defaults(func=cmd_query)

    p_stats = sub.add_parser("stats", help="show aggregate stats")
    p_stats.add_argument("--project-root", required=True)
    p_stats.set_defaults(func=cmd_stats)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
