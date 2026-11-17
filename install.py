#!/usr/bin/env python3
"""Installer / uninstaller for the Antigravity Sidebar Real-Time Usage widget.

Safely patches `dist/preload.js` inside Antigravity's `app.asar` archive,
updating file offsets, byte sizes, SHA-256 integrity hashes, and Chromium Pickle
headers without affecting existing customizations (such as Chinese localization).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path

START_MARKER = "/* --- ANTIGRAVITY SIDEBAR USAGE START --- */"
END_MARKER = "/* --- ANTIGRAVITY SIDEBAR USAGE END --- */"

STRIP_PATTERN = re.compile(
    r"(?:\r?\n\r?\n)?"
    + re.escape(START_MARKER)
    + r"[\s\S]*?"
    + re.escape(END_MARKER)
    + r"(?:\r?\n)?",
)

HERE = Path(__file__).resolve().parent
DEFAULT_WIDGET_PATH = HERE / "src" / "sidebar-usage-widget.js"


def default_asar_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Programs" / "antigravity" / "resources" / "app.asar"
    return Path.home() / "AppData" / "Local" / "Programs" / "antigravity" / "resources" / "app.asar"


def repair_agy_node_wrapper(dry_run: bool = False) -> dict:
    """Ensure %APPDATA%\\Antigravity\\bin\\agy-node.cmd uses pure-ASCII CRLF and is read-only."""
    app_data = os.environ.get("APPDATA")
    roaming_dir = Path(app_data) if app_data else (Path.home() / "AppData" / "Roaming")
    wrapper_path = roaming_dir / "Antigravity" / "bin" / "agy-node.cmd"
    expected = (
        b"@echo off\r\n"
        b"set ELECTRON_RUN_AS_NODE=1\r\n"
        b'"%LOCALAPPDATA%\\Programs\\antigravity\\Antigravity.exe" %*\r\n'
    )
    repaired = False
    if wrapper_path.exists() or wrapper_path.parent.is_dir():
        existing = wrapper_path.read_bytes() if wrapper_path.exists() else b""
        is_ro = wrapper_path.exists() and not (wrapper_path.stat().st_mode & stat.S_IWRITE)
        if existing != expected or not is_ro:
            if not dry_run:
                if wrapper_path.exists():
                    os.chmod(wrapper_path, stat.S_IWRITE | stat.S_IREAD)
                wrapper_path.write_bytes(expected)
                os.chmod(wrapper_path, stat.S_IREAD)
                repaired = True
    read_only = wrapper_path.exists() and not (wrapper_path.stat().st_mode & stat.S_IWRITE)
    return {
        "path": str(wrapper_path),
        "exists": wrapper_path.exists(),
        "repaired": repaired,
        "read_only": read_only,
    }


def read_asar(asar_path: Path) -> tuple[dict, bytes]:
    """Read an ASAR file and return (header_tree, payload_bytes)."""
    raw = asar_path.read_bytes()
    if len(raw) < 16:
        raise ValueError(f"Invalid ASAR file (too small): {asar_path}")
    u0, u1, _u2, u3 = struct.unpack("<4I", raw[:16])
    if u0 != 4:
        raise ValueError(f"Unexpected ASAR Pickle header prefix {u0} (expected 4)")
    payload_base = 8 + u1
    if payload_base > len(raw) or 16 + u3 > payload_base:
        raise ValueError("Corrupted ASAR header lengths")
    tree = json.loads(raw[16 : 16 + u3].decode("utf-8"))
    payload = raw[payload_base:]
    return tree, payload


def iter_file_entries(node: dict, prefix: str = ""):
    """Yield (relative_path, entry_dict) for every file in the ASAR header tree."""
    for name, child in node.get("files", {}).items():
        rel = f"{prefix}{name}"
        if "files" in child:
            yield from iter_file_entries(child, f"{rel}/")
        else:
            yield rel, child


def verify_asar(tree: dict, payload: bytes) -> None:
    """Verify offsets, sizes, and SHA-256 integrity hashes for all ASAR files."""
    for rel, entry in iter_file_entries(tree):
        if "offset" not in entry or "size" not in entry:
            continue
        offset = int(entry["offset"])
        size = int(entry["size"])
        if offset < 0 or offset + size > len(payload):
            raise ValueError(f"ASAR entry out of bounds: {rel} (offset={offset}, size={size})")
        chunk = payload[offset : offset + size]
        integrity = entry.get("integrity")
        if integrity:
            algo = integrity.get("algorithm", "").upper()
            if algo != "SHA256":
                raise ValueError(f"Unsupported integrity algorithm {algo!r} on {rel}")
            actual_hash = hashlib.sha256(chunk).hexdigest()
            if actual_hash != integrity.get("hash"):
                raise ValueError(f"Hash mismatch on {rel}: expected {integrity.get('hash')}, got {actual_hash}")
            block_size = int(integrity.get("blockSize") or 4194304)
            expected_blocks = integrity.get("blocks") or []
            actual_blocks = [
                hashlib.sha256(chunk[i : i + block_size]).hexdigest()
                for i in range(0, len(chunk), block_size)
            ] if chunk else []
            if expected_blocks and actual_blocks != expected_blocks:
                raise ValueError(f"Block hash mismatch on {rel}")


def get_preload_entry(tree: dict) -> dict:
    try:
        return tree["files"]["dist"]["files"]["preload.js"]
    except KeyError as exc:
        raise KeyError("Could not find dist/preload.js in ASAR tree") from exc


def strip_usage_block(text: str) -> str:
    """Remove any existing Sidebar Usage injection block while leaving other code intact."""
    return STRIP_PATTERN.sub("", text)


def build_integrity(data: bytes, block_size: int = 4194304) -> dict:
    blocks = (
        [hashlib.sha256(data[i : i + block_size]).hexdigest() for i in range(0, len(data), block_size)]
        if data
        else []
    )
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": block_size,
        "blocks": blocks,
    }


def repack_with_preload(tree: dict, payload: bytes, new_preload_bytes: bytes) -> tuple[dict, bytes, bytes]:
    """Return (new_tree, new_payload, packed_asar_bytes) after replacing dist/preload.js."""
    preload_entry = get_preload_entry(tree)
    old_offset = int(preload_entry["offset"])
    old_size = int(preload_entry["size"])
    delta = len(new_preload_bytes) - old_size

    new_tree = json.loads(json.dumps(tree, ensure_ascii=False))
    new_preload_entry = get_preload_entry(new_tree)

    for _rel, entry in iter_file_entries(new_tree):
        if entry is new_preload_entry or "offset" not in entry:
            continue
        entry_offset = int(entry["offset"])
        if entry_offset > old_offset:
            entry["offset"] = str(entry_offset + delta)

    block_size = int(new_preload_entry.get("integrity", {}).get("blockSize") or 4194304)
    new_preload_entry["size"] = len(new_preload_bytes)
    new_preload_entry["integrity"] = build_integrity(new_preload_bytes, block_size)

    new_payload = payload[:old_offset] + new_preload_bytes + payload[old_offset + old_size :]

    json_bytes = json.dumps(new_tree, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    u3 = len(json_bytes)
    padded_len = (u3 + 3) & ~3
    u2 = 4 + padded_len
    u1 = 4 + u2
    header = struct.pack("<4I", 4, u1, u2, u3) + json_bytes + (b"\x00" * (padded_len - u3))
    return new_tree, new_payload, header + new_payload


def _is_lock_error(exc: OSError) -> bool:
    return isinstance(exc, PermissionError) or getattr(exc, "winerror", None) in (5, 32)


def write_asar_atomic(asar_path: Path, full_bytes: bytes, restart_app: bool = False) -> bool:
    """Atomically replace app.asar, optionally closing and relaunching Antigravity if locked."""
    tmp_path = asar_path.with_name(asar_path.name + ".usage.tmp")
    restarted_app = False
    try:
        tmp_path.write_bytes(full_bytes)
        try:
            os.replace(tmp_path, asar_path)
            return False
        except OSError as exc:
            if not (_is_lock_error(exc) and restart_app):
                raise
            print("[提示] 检测到 Antigravity 正在运行并占用 app.asar，正在自动关闭客户端以完成操作...")
            subprocess.run(["taskkill", "/F", "/IM", "Antigravity.exe"], capture_output=True)
            last_exc: OSError = exc
            replaced = False
            for _ in range(20):
                time.sleep(0.5)
                try:
                    os.replace(tmp_path, asar_path)
                    replaced = True
                    break
                except OSError as retry_exc:
                    if not _is_lock_error(retry_exc):
                        raise
                    last_exc = retry_exc
            if not replaced:
                raise last_exc
            exe_path = asar_path.parent.parent / "Antigravity.exe"
            if exe_path.is_file():
                creationflags = (
                    getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
                )
                subprocess.Popen(
                    [str(exe_path)],
                    cwd=str(exe_path.parent),
                    creationflags=creationflags,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                )
                restarted_app = True
            return restarted_app
    except OSError:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise


def inspect_status(asar_path: Path) -> dict:
    tree, payload = read_asar(asar_path)
    verify_asar(tree, payload)
    node_wrapper = repair_agy_node_wrapper()
    entry = get_preload_entry(tree)
    offset = int(entry["offset"])
    size = int(entry["size"])
    preload_text = payload[offset : offset + size].decode("utf-8", errors="replace")
    bak_path = asar_path.with_name(asar_path.name + ".usage.bak")
    return {
        "asar_path": str(asar_path),
        "installed": START_MARKER in preload_text and END_MARKER in preload_text,
        "has_cn_localization": "ANTIGRAVITY CHINESE LOCALIZATION START" in preload_text,
        "preload_size": size,
        "preload_sha256": entry.get("integrity", {}).get("hash", ""),
        "backup_exists": bak_path.is_file(),
        "backup_path": str(bak_path),
        "node_wrapper": node_wrapper,
    }


def apply_action(
    asar_path: Path,
    action: str,
    widget_path: Path = DEFAULT_WIDGET_PATH,
    dry_run: bool = False,
    restart_app: bool = False,
) -> dict:
    if not asar_path.is_file():
        raise FileNotFoundError(f"找不到 ASAR 文件: {asar_path}")

    if action == "status":
        return inspect_status(asar_path)

    tree, payload = read_asar(asar_path)
    verify_asar(tree, payload)

    entry = get_preload_entry(tree)
    offset = int(entry["offset"])
    size = int(entry["size"])
    preload_text = payload[offset : offset + size].decode("utf-8")
    clean_text = strip_usage_block(preload_text)

    if action == "install":
        if not widget_path.is_file():
            raise FileNotFoundError(f"找不到组件脚本: {widget_path}")
        widget_code = widget_path.read_text(encoding="utf-8").strip()
        if START_MARKER not in widget_code or END_MARKER not in widget_code:
            widget_code = f"{START_MARKER}\n{widget_code}\n{END_MARKER}"
        new_text = f"{clean_text}\n\n{widget_code}"
    elif action == "uninstall":
        new_text = clean_text
    else:
        raise ValueError(f"Unsupported action: {action}")

    new_preload_bytes = new_text.encode("utf-8")
    new_tree, new_payload, full_bytes = repack_with_preload(tree, payload, new_preload_bytes)
    verify_asar(new_tree, new_payload)

    repair_agy_node_wrapper(dry_run=dry_run)

    restarted_app = False
    if not dry_run:
        bak_path = asar_path.with_name(asar_path.name + ".usage.bak")
        if action == "install" and not bak_path.exists():
            shutil.copy2(asar_path, bak_path)
        restarted_app = write_asar_atomic(asar_path, full_bytes, restart_app=restart_app)

    return {
        "action": action,
        "dry_run": dry_run,
        "asar_path": str(asar_path),
        "old_size": size,
        "new_size": len(new_preload_bytes),
        "new_sha256": get_preload_entry(new_tree)["integrity"]["hash"],
        "installed": action == "install",
        "restarted_app": restarted_app,
    }


def _maybe_pause(pause: bool) -> None:
    if pause and sys.stdin is not None and sys.stdin.isatty():
        try:
            input("\n按回车键退出...")
        except EOFError:
            pass


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Antigravity 左侧栏实时用量卡片安装器")
    parser.add_argument(
        "--asar",
        type=Path,
        default=default_asar_path(),
        help="Antigravity app.asar 路径",
    )
    parser.add_argument(
        "--action",
        choices=("install", "uninstall", "status"),
        default="install",
        help="执行操作: install / uninstall / status (默认: install)",
    )
    parser.add_argument(
        "--widget",
        type=Path,
        default=DEFAULT_WIDGET_PATH,
        help="前端注入脚本路径",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅在内存中校验打包，不写入磁盘",
    )
    parser.add_argument(
        "--restart-app",
        action="store_true",
        help="当 app.asar 被 Antigravity 占用时，自动关闭并重新启动客户端",
    )
    parser.add_argument(
        "--pause",
        action="store_true",
        help="交互终端下运行结束前提示按回车键退出",
    )
    args = parser.parse_args(argv)

    try:
        res = apply_action(
            args.asar,
            args.action,
            widget_path=args.widget,
            dry_run=args.dry_run,
            restart_app=args.restart_app,
        )
    except OSError as exc:
        if _is_lock_error(exc):
            print(
                f"[错误] 无法写入 {args.asar}（文件正在被 Antigravity 占用或权限不足）。\n"
                f"请先完全退出 Antigravity（包括系统托盘右下角图标），或附加 --restart-app 参数。\n"
                f"详细信息: {exc}",
                file=sys.stderr,
            )
            _maybe_pause(args.pause)
            return 1
        print(f"[错误] {exc}", file=sys.stderr)
        _maybe_pause(args.pause)
        return 1
    except Exception as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        _maybe_pause(args.pause)
        return 1

    if args.action == "status":
        print(f"ASAR 路径: {res['asar_path']}")
        print(f"实时用量卡片状态: {'已安装' if res['installed'] else '未安装'}")
        print(f"汉化补丁保留状态: {'已保留' if res['has_cn_localization'] else '未检测到'}")
        print(f"preload.js 大小: {res['preload_size']} 字节")
        print(f"preload.js SHA256: {res['preload_sha256']}")
        print(f"自动备份文件: {'存在 (' + res['backup_path'] + ')' if res['backup_exists'] else '无'}")
    else:
        mode = "（演练模式，未写入磁盘）" if res["dry_run"] else ""
        op_label = "安装/更新" if args.action == "install" else "卸载"
        print(f"[成功] {op_label}完成{mode}")
        print(f"目标 ASAR: {res['asar_path']}")
        print(f"preload.js 大小变化: {res['old_size']} -> {res['new_size']} 字节")
        print(f"新 SHA256: {res['new_sha256']}")
        if res.get("restarted_app"):
            print("已自动重启 Antigravity 桌面客户端。")
        elif not res["dry_run"]:
            print("请重新启动 Antigravity 桌面客户端使界面生效。")
    _maybe_pause(args.pause)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
