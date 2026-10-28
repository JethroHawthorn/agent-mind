"""Real controlling-terminal fixture. Demonstrates workflow, NOT human authentication."""
import errno
import json
import os
import pty
import re
import select
import sys
import time

pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
output = b""
announced = False
finished = False
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                part = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not part:
                break
            output += part
            # ONLCR may add a CR to a program's existing CRLF. The challenge
            # remains exact; only the test terminal's newline is normalized.
            match = re.search(rb"(?:^|\n)(CONFIRM [a-f0-9]{64} [a-f0-9]{32})\r*\n> ", output)
            if match and not announced:
                announced = True
                print(json.dumps({"event": "ready", "output": output.decode("utf8", "replace")}), flush=True)
                # Parent supplies test response only after observing the exact prompt.
                command = json.loads(sys.stdin.readline())
                answer = match.group(1).decode() if command["response"] == "exact" else command["response"]
                os.write(fd, answer.encode() + b"\n")
    else:
        os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
    finished = True
    print(json.dumps({"event": "exit", "status": os.waitstatus_to_exitcode(status), "output": output.decode("utf8", "replace")}), flush=True)
finally:
    os.close(fd)
    if not finished:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
