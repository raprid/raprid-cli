#!/usr/bin/env python3
# 疑似端末 (PTY) の中でコマンドを動かし、キー入力・端末サイズの変更・シグナルを順に与える試験用ハーネス。
# Node.js には PTY の API が無いため、tui-pty.test.ts から呼ぶ。
#
#   python3 test/pty-harness.py <spec.json>
#
# spec: {"argv": [...], "cwd": "...", "env": {...}, "cols": 100, "rows": 30, "timeout": 20,
#        "steps": [{"expect": "文字列", "timeout": 5} | {"send": "q"} | {"wait": 0.5}
#                  | {"resize": [cols, rows]} | {"signal": "TERM"} | {"run": [...], "env": {...}}]}
# 結果 (stdout の JSON): 終了状態、出力 (UTF-8)、各 expect の成否、終了後の端末設定 (icanon・echo)
#
# コマンドは sh で包み、終了後も sh がセッションを保っている間に端末設定を読む
# (macOS はセッションリーダーの終了後に slave 側を読めないため)。signal は sh の子 (対象のコマンド) へ送る。

import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

MARKER = "__RAPRID_PTY_EXIT__"


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        spec = json.load(handle)
    master, slave = os.openpty()
    set_size(slave, spec.get("cols", 100), spec.get("rows", 30))
    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for target in (0, 1, 2):
            os.dup2(slave, target)
        os.close(master)
        if slave > 2:
            os.close(slave)
        os.chdir(spec["cwd"])
        script = '"$@"; code=$?; printf "\\n%s%s\\n" "' + MARKER + '" "$code"; sleep 2'
        os.execve("/bin/sh", ["/bin/sh", "-c", script, "sh", *spec["argv"]], spec["env"])

    output = bytearray()
    status = None

    def pump(seconds):
        nonlocal status
        end = time.monotonic() + seconds
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            ready, _, _ = select.select([master], [], [], min(remaining, 0.05))
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)
            if status is None:
                done, code = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = code

    expects = []
    started = time.monotonic()
    offset = 0
    for step in spec.get("steps", []):
        if "expect" in step:
            needle = step["expect"]
            deadline = time.monotonic() + step.get("timeout", 5)
            found = False
            while time.monotonic() < deadline:
                text = output.decode("utf-8", "replace")
                index = text.find(needle, offset)
                if index >= 0:
                    offset = index + len(needle)
                    found = True
                    break
                pump(0.05)
            expects.append({"expect": needle, "found": found, "at": round(time.monotonic() - started, 3)})
        elif "send" in step:
            os.write(master, step["send"].encode("utf-8"))
            pump(step.get("after", 0.05))
        elif "run" in step:
            subprocess.run(step["run"], cwd=spec["cwd"], env={**spec["env"], **step.get("env", {})}, capture_output=True)
            pump(step.get("after", 0.05))
        elif "wait" in step:
            pump(step["wait"])
        elif "resize" in step:
            cols, rows = step["resize"]
            set_size(master, cols, rows)
            try:
                os.kill(pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass
            pump(step.get("after", 0.2))
        elif "signal" in step:
            children = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
            for child in children:
                try:
                    os.kill(int(child), getattr(signal, "SIG" + step["signal"]))
                except ProcessLookupError:
                    pass
            pump(step.get("after", 0.2))

    deadline = time.monotonic() + spec.get("timeout", 20)
    exit_code = None
    while time.monotonic() < deadline:
        text = output.decode("utf-8", "replace")
        index = text.find(MARKER)
        if index >= 0 and "\n" in text[index:]:
            exit_code = int(text[index + len(MARKER):].split()[0])
            break
        pump(0.05)
    timed_out = exit_code is None
    try:
        attrs = termios.tcgetattr(slave)
        modes = {"icanon": bool(attrs[3] & termios.ICANON), "echo": bool(attrs[3] & termios.ECHO)}
    except termios.error:
        modes = None
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    text = output.decode("utf-8", "replace")
    result = {
        "exitCode": exit_code,
        "timedOut": timed_out,
        "output": text[: text.find(MARKER)] if MARKER in text else text,
        "expects": expects,
        "termios": modes,
    }
    print(json.dumps(result, ensure_ascii=False))


main()
