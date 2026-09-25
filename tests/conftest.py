"""Shared pytest setup for the pack/harness tests.

Windows: a bare `bash` handed to CreateProcess resolves to C:\\Windows\\System32\\bash.exe (the WSL
launcher) BEFORE any PATH entry, and that launcher fails with "execvpe(/bin/bash) failed" unless a
WSL distro is installed. Tests that shell out to scripts/*.sh (dispatch.sh, plan_commit.sh) need a
real bash, so on Windows every subprocess started with the bare name "bash" is redirected to Git
for Windows' bash by absolute path. Changing PATH cannot fix this, because System32 wins first.
Added 2026-09-25 (ORCH) after ~21 tests failed in the nightly audit for exactly this reason.
"""
import os
import shutil
import subprocess
from pathlib import Path


def _git_bash() -> str | None:
    if os.name != "nt":
        return None
    candidates = []
    git = shutil.which("git")
    if git:
        root = Path(git).resolve().parent.parent          # ...\Git\cmd\git.exe -> ...\Git
        candidates += [root / "usr" / "bin" / "bash.exe", root / "bin" / "bash.exe"]
    candidates += [Path(r"C:\Program Files\Git\usr\bin\bash.exe"), Path(r"C:\Program Files\Git\bin\bash.exe")]
    for cand in candidates:
        if cand.exists():
            return str(cand)
    return None


_GIT_BASH = _git_bash()

if _GIT_BASH is not None:
    _real_popen_init = subprocess.Popen.__init__

    def _popen_init(self, args, *a, **kw):
        if isinstance(args, (list, tuple)) and args and args[0] == "bash":
            args = [_GIT_BASH, *args[1:]]
        _real_popen_init(self, args, *a, **kw)

    subprocess.Popen.__init__ = _popen_init
