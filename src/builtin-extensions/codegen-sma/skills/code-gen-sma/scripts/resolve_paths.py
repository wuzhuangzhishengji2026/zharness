import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(
        description="Resolve config/script file paths (project KnowledgeBase > skill dir)"
    )
    parser.add_argument("project_root", help="项目根目录")
    parser.add_argument("skill_root", help="技能根目录")
    parser.add_argument("-o", "--output", help="将 JSON 结果写入指定文件（推荐）")
    args = parser.parse_args()

    project_root = args.project_root
    skill_root = args.skill_root

    entries = {
        "config": {
            "build": "config/build-env.yaml",
            "project": "config/project-env.yaml",
            "retrieval_constraints": "config/retrieval-constraints.yaml",
            "decomposer_constraints": "config/decomposer-constraints.yaml",
        },
        "script": {
            "sync_to_remote": "scripts/sync_to_remote.py",
        },
    }

    result = {"config": {}, "script": {}}
    missing = []

    for section, items in entries.items():
        for key, rel in items.items():
            kb_path = os.path.join(project_root, "KnowledgeBase", rel)
            skill_path = os.path.join(skill_root, rel)
            if os.path.isfile(kb_path):
                result[section][key] = kb_path
            elif os.path.isfile(skill_path):
                result[section][key] = skill_path
            else:
                result[section][key] = skill_path
                missing.append(
                    {"key": key, "kb_path": kb_path, "skill_path": skill_path}
                )

    if missing:
        payload = {"error": "配置文件路径未找到", "missing": missing}
        code = 2
    else:
        payload = result
        code = 0

    if args.output:
        out_dir = os.path.dirname(os.path.abspath(args.output))
        os.makedirs(out_dir, exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    else:
        print(json.dumps(payload, ensure_ascii=False))

    sys.exit(code)


if __name__ == "__main__":
    main()
