#!/usr/bin/env python3
# 疑似端末 (PTY) の中でコマンドを動かし、キー入力・端末サイズの変更・シグナルを順に与える試験用ハーネス。
# Node.js には PTY の API が無いため、tui-pty.test.ts から呼ぶ。
#
#   python3 test/pty-harness.py <spec.json>
#
# spec: {"argv": [...], "cwd": "...", "env": {...}, "cols": 100, "rows": 30, "timeout": 20,
#        "steps": [{"expect": "文字列", "timeout": 5} | {"send": "q"} | {"wait": 0.5}
#                  | {"resize": [cols, rows]} | {"signal": "TERM"} | {"run": [...], "env": {...}}]}
# 結果 (stdout の JSON): 終了コード (シグナルなら 128+番号)、出力 (UTF-8)、各 expect の成否、
# 送ったシグナル、終了後の端末設定 (icanon・echo)
#
# 端末のセッションは中間のプロセス (leader) が持ち、対象のコマンドはその子として動かす。
# macOS はセッションリーダーの終了後に slave 側の端末設定を読めないため、leader は対象の終了後も
# ハーネスが設定を読み終えるまで待つ。対象の PID と終了状態は leader からパイプで受け取る
# (pgrep や ps に頼らない。サンドボックスなどで使えない環境があるため)。

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


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def exit_code(status):
    code = os.waitstatus_to_exitcode(status)
    return 128 - code if code < 0 else code  # シェルと同じく、シグナルは 128+番号


def run_leader(spec, slave, report, hold):
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for target in (0, 1, 2):
        os.dup2(slave, target)
    child = os.fork()
    if child == 0:
        os.close(report)
        os.close(hold)
        if slave > 2:
            os.close(slave)
        os.chdir(spec["cwd"])
        os.execve(spec["argv"][0], spec["argv"], spec["env"])
    os.write(report, f"pid {child}\n".encode())
    _, status = os.waitpid(child, 0)
    os.write(report, f"exit {exit_code(status)}\n".encode())
    os.read(hold, 1)  # ハーネスが端末設定を読み終えるまでセッションを保つ
    os._exit(0)


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        spec = json.load(handle)
    master, slave = os.openpty()
    set_size(slave, spec.get("cols", 100), spec.get("rows", 30))
    report_r, report_w = os.pipe()
    hold_r, hold_w = os.pipe()
    leader = os.fork()
    if leader == 0:
        os.close(master)
        os.close(report_r)
        os.close(hold_w)
        run_leader(spec, slave, report_w, hold_r)
    os.close(report_w)
    os.close(hold_r)

    output = bytearray()
    reports = bytearray()
    state = {"pid": None, "exit": None}

    def pump(seconds):
        end = time.monotonic() + seconds
        while True:
            remaining = end - time.monotonic()
            ready, _, _ = select.select([master, report_r], [], [], max(0, min(remaining, 0.05)))
            if master in ready:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass
            if report_r in ready:
                reports.extend(os.read(report_r, 4096))
                for line in reports.decode().splitlines():
                    kind, _, value = line.partition(" ")
                    if kind in state and value:
                        state[kind] = int(value)
            if remaining <= 0:
                return

    pump(0.05)
    expects = []
    signals = []
    started = time.monotonic()
    offset = 0
    for step in spec.get("steps", []):
        if "expect" in step:
            needle = step["expect"]
            deadline = time.monotonic() + step.get("timeout", 5)
            found = False
            while time.monotonic() < deadline:
                index = output.decode("utf-8", "replace").find(needle, offset)
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
            if state["pid"] is not None:
                try:
                    os.kill(state["pid"], signal.SIGWINCH)
                except ProcessLookupError:
                    pass
            pump(step.get("after", 0.2))
        elif "signal" in step:
            sent = {"signal": step["signal"], "pid": state["pid"], "sent": False, "error": None}
            if state["pid"] is None:
                sent["error"] = "対象の PID を受け取っていない"
            else:
                try:
                    os.kill(state["pid"], getattr(signal, "SIG" + step["signal"]))
                    sent["sent"] = True
                except OSError as error:
                    sent["error"] = str(error)
            signals.append(sent)
            pump(step.get("after", 0.2))

    deadline = time.monotonic() + spec.get("timeout", 20)
    while state["exit"] is None and time.monotonic() < deadline:
        pump(0.05)
    timed_out = state["exit"] is None
    if timed_out and state["pid"] is not None:
        try:
            os.kill(state["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass
        pump(0.5)
    pump(0.1)
    try:
        attrs = termios.tcgetattr(slave)
        modes = {"icanon": bool(attrs[3] & termios.ICANON), "echo": bool(attrs[3] & termios.ECHO)}
    except termios.error:
        modes = None
    os.close(hold_w)  # leader を終わらせる
    os.waitpid(leader, 0)
    print(json.dumps({
        "exitCode": None if timed_out else state["exit"],
        "timedOut": timed_out,
        "output": output.decode("utf-8", "replace"),
        "expects": expects,
        "signals": signals,
        "termios": modes,
    }, ensure_ascii=False))


main()
