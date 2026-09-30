import json
import sys
import os
import glob
import subprocess
import time
import fnmatch


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def find_files(local_root, include_patterns, exclude_patterns):
    matched = set()
    for pattern in include_patterns:
        abs_p = os.path.join(local_root, pattern)
        for f in glob.glob(abs_p, recursive=True):
            if os.path.isfile(f):
                matched.add(os.path.normpath(f))

    result = []
    for f in sorted(matched):
        rel = os.path.relpath(f, local_root)
        ex = False
        for e in exclude_patterns:
            if fnmatch.fnmatch(f, os.path.join(local_root, e)):
                ex = True
                break
            if fnmatch.fnmatch(rel, e):
                ex = True
                break
            if e.endswith("/**") and rel.startswith(e[:-3]):
                ex = True
                break
        if not ex:
            result.append((f, rel.replace("\\", "/")))
    return result


def ensure_remote_dirs(sshpass, ssh, host, port, user, password, dirs):
    if not dirs:
        return True
    escaped = " ".join(d.replace(" ", "\\ ") for d in sorted(dirs))
    cmd = [
        sshpass,
        ssh,
        "-p",
        str(port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "PasswordAuthentication=yes",
        f"{user}@{host}",
        f"mkdir -p {escaped}",
    ]
    env = os.environ.copy()
    env["SSHPASS"] = password
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
    if r.returncode != 0:
        print(f"mkdir error: {r.stderr.strip()}", file=sys.stderr)
        return False
    return True


def upload_file(sshpass, scp, host, port, user, password, local, remote):
    cmd = [
        sshpass,
        scp,
        "-P",
        str(port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "PasswordAuthentication=yes",
        local,
        f"{user}@{host}:{remote}",
    ]
    env = os.environ.copy()
    env["SSHPASS"] = password
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=env)
    return r.returncode == 0, r.stderr.strip()


def main():
    if len(sys.argv) != 2:
        out = {
            "status": "FAILED",
            "files_synced": 0,
            "errors": ["Usage: python sync_to_remote.py <config.json>"],
        }
        print(json.dumps(out))
        sys.exit(1)

    try:
        cfg = load_config(sys.argv[1])
    except Exception as e:
        out = {
            "status": "FAILED",
            "files_synced": 0,
            "errors": [f"config load failed: {e}"],
        }
        print(json.dumps(out))
        sys.exit(1)

    local_root = cfg.get("local_root", os.getcwd())
    local_root_norm = os.path.normpath(local_root)
    host = cfg["remote_host"]
    port = cfg.get("remote_port", 22)
    user = cfg["remote_user"]
    password = cfg.get("remote_password", "")
    remote_path = cfg["remote_path"]
    file_list = cfg.get("file_list", [])
    relative_files = cfg.get("relative_files", [])
    include = cfg.get("sync_include", [])
    exclude = cfg.get("sync_exclude", [])
    sshpass = cfg.get("sshpass_path", "sshpass")
    scp = cfg.get("scp_path", "scp")
    ssh = cfg.get("ssh_path", "ssh")

    print(f"sync: {user}@{host}:{port} {remote_path}", file=sys.stderr)

    if relative_files:
        files = []
        for f in relative_files:
            rel = f.replace("\\", "/")
            abs_f = os.path.join(local_root_norm, rel)
            if not os.path.isfile(abs_f):
                print(f"  skip (not found): {f}", file=sys.stderr)
                continue
            files.append((abs_f, rel))
    elif file_list:
        files = []
        for f in file_list:
            abs_f = os.path.abspath(f)
            if not os.path.isfile(abs_f):
                print(f"  skip (not found): {f}", file=sys.stderr)
                continue
            rel = os.path.relpath(abs_f, local_root_norm).replace("\\", "/")
            files.append((abs_f, rel))
    else:
        files = find_files(local_root, include, exclude)
    print(f"sync: {len(files)} files to transfer", file=sys.stderr)

    if not files:
        print(json.dumps({"status": "SUCCESS", "files_synced": 0, "errors": []}))
        return

    remote_dirs = set()
    mappings = []
    for local_path, rel_path in files:
        remote_file = os.path.join(remote_path, rel_path).replace("\\", "/")
        remote_dirs.add(os.path.dirname(remote_file))
        mappings.append((local_path, rel_path, remote_file))

    if not ensure_remote_dirs(
        sshpass, ssh, host, port, user, password, list(remote_dirs)
    ):
        print(
            json.dumps(
                {
                    "status": "FAILED",
                    "files_synced": 0,
                    "errors": ["remote dir creation failed"],
                }
            )
        )
        sys.exit(1)

    errors = []
    synced = 0
    for local_path, rel_path, remote_file in mappings:
        ok, err = upload_file(
            sshpass, scp, host, port, user, password, local_path, remote_file
        )
        if ok:
            synced += 1
            print(f"  OK  {rel_path}", file=sys.stderr)
        else:
            print(f"  RETRY {rel_path}: {err[:80]}", file=sys.stderr)
            time.sleep(1)
            ok2, err2 = upload_file(
                sshpass, scp, host, port, user, password, local_path, remote_file
            )
            if ok2:
                synced += 1
                print(f"  OK  {rel_path} (retry)", file=sys.stderr)
            else:
                errors.append(f"{rel_path}: {err2 or err}")
                print(f"  FAIL {rel_path}", file=sys.stderr)

    out = {
        "status": "SUCCESS" if not errors else "FAILED",
        "files_synced": synced,
        "errors": errors,
    }
    print(json.dumps(out))
    sys.exit(0 if not errors else 1)


if __name__ == "__main__":
    main()
