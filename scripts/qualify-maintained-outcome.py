"""Exercise Mill's maintained outcome handoff with an installed Python wheel."""

import base64
from datetime import datetime, timezone
from functools import partial
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
from time import monotonic, sleep
from unittest.mock import patch
import zipfile


PROBE = Path(__file__).with_name("qualify-maintained-outcome-probe.py")
POLICY = "outcome.json"
RUNTIME = "runtime.json"
CHECK = "verify-wheel.py"
REPORT = "evidence/verification-original.json"
FAILED_REPORT = "evidence/verification-recheck.json"
DUPLICATE_REPORT = "evidence/verification-duplicate.json"
INSTALL_REPORT = "evidence/verification-install-refused.json"
INVOCATION_REPORT = "evidence/verification-cli-exit.json"
CLAIM = (
    "The wheel bytes install offline when staged as "
    "mill_maintenance_probe-1.0.0-py3-none-any.whl and the installed "
    'CLI prints {"allocated":3}.'
)
ACCEPTANCE = "evidence/acceptance.json"
PILOT_BUDGET_SECONDS = 300


def encode(value):
    # These envelopes use fixed ASCII keys and string values.
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path, value):
    path.write_bytes(encode(value) + b"\n")


def stop_process_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def run_command(argv, root, env, *, deadline, timeout=100, input_bytes=None):
    if monotonic() >= deadline:
        raise TimeoutError("The maintained wheel pilot reached its overall deadline.")
    previous_handler = signal.getsignal(signal.SIGTERM)
    process = None
    phase = "launching"
    pending = None
    dispatched = False
    reroute_default = False

    def handle_sigterm(signum, frame):
        nonlocal phase, pending, dispatched, reroute_default
        if previous_handler == signal.SIG_IGN:
            return
        if phase != "running":
            pending = (signum, frame)
            return
        phase = "interrupting"
        dispatched = True
        if previous_handler == signal.SIG_DFL:
            reroute_default = True
            raise SystemExit(128 + signum)
        previous_handler(signum, frame)
        phase = "running"

    # A Python handler defers the signal without passing a blocked signal
    # mask to the new process. The outer cleanup is armed before dispatch.
    signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        try:
            process = subprocess.Popen(
                argv, cwd=root, env=env, start_new_session=True,
                stdin=subprocess.DEVNULL if input_bytes is None else subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            phase = "running"
            if pending is not None:
                received = pending
                pending = None
                handle_sigterm(*received)
            stdout, stderr = process.communicate(
                input=input_bytes, timeout=min(timeout, deadline - monotonic()),
            )
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError(f"{Path(argv[0]).name} left descendants in its process group.")
            phase = "cleaning"
        except BaseException:
            phase = "cleaning"
            raise
    except BaseException:
        if process is not None:
            stop_process_group(process)
        raise
    finally:
        try:
            if process is not None:
                if process.stdin is not None:
                    process.stdin.close()
                process.stdout.close()
                process.stderr.close()
        finally:
            signal.signal(signal.SIGTERM, previous_handler)
            if reroute_default or (pending is not None and previous_handler == signal.SIG_DFL):
                signal.raise_signal(signal.SIGTERM)
            elif pending is not None and not dispatched and callable(previous_handler):
                previous_handler(*pending)
    if process.returncode:
        raise RuntimeError(
            f"{Path(argv[0]).name} exited {process.returncode}\n"
            + (stdout + stderr).decode("utf-8", errors="replace")
        )
    return stdout


def verify_process_group_cleanup(root, env, run):
    launcher = """
from pathlib import Path
import subprocess
import sys
from time import monotonic, sleep

subprocess.Popen(
    [sys.executable, "-I", "-B", "-S", "-c", sys.argv[1]],
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
deadline = monotonic() + 3
while not Path("child-ready").exists():
    if monotonic() >= deadline:
        raise RuntimeError("The process cleanup control never started its child.")
    sleep(0.01)
"""
    child = """
from pathlib import Path
from time import sleep

Path("child-ready").touch()
sleep(1)
Path("unexpected-sentinel").touch()
"""
    scratch = root / "process-control"
    scratch.mkdir()
    try:
        run([sys.executable, "-I", "-B", "-S", "-c", launcher, child], scratch, env, timeout=5)
    except RuntimeError as error:
        expect("left descendants in its process group" in str(error), str(error))
    else:
        raise RuntimeError("The pilot accepted a command that left a detached-pipe child running.")
    expect((scratch / "child-ready").is_file(), "The process cleanup control did not start.")
    sleep(1.1)
    expect(not (scratch / "unexpected-sentinel").exists(), "The pilot left a child running after cleanup.")


def verify_launch_interruption(root, env, run):
    launch = subprocess.Popen
    kill_group = os.killpg
    children = []

    def interrupt_before_registration(*args, **kwargs):
        child = launch(*args, **kwargs)
        children.append(child)
        expect(os.getpgid(child.pid) == child.pid, "Cancellation control did not launch a private group.")
        os.kill(os.getpid(), signal.SIGTERM)
        return child

    def interrupt_during_cleanup(group, signum):
        if signum == signal.SIGKILL:
            os.kill(os.getpid(), signal.SIGTERM)
        return kill_group(group, signum)

    previous_handler = signal.signal(signal.SIGTERM, terminate)
    try:
        with tempfile.TemporaryDirectory(prefix="cancel-", dir=root) as directory:
            with patch.object(subprocess, "Popen", interrupt_before_registration), patch.object(
                os, "killpg", interrupt_during_cleanup,
            ):
                try:
                    run([sys.executable, "-I", "-B", "-S", "-c", "import time; time.sleep(10)"],
                        Path(directory), env, timeout=5)
                except SystemExit as error:
                    expect(error.code == 128 + signal.SIGTERM, "The original termination handler was changed.")
                else:
                    raise RuntimeError("The pilot ignored termination during child registration.")
            expect(
                len(children) == 1 and children[0].poll() == -signal.SIGKILL,
                "The pilot did not stop the child before scratch cleanup.",
            )
            try:
                kill_group(children[0].pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError("The cancelled process group survived until scratch cleanup.")
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


def key_pair(root, name, env, run):
    key = root / f"{name}.pem"
    key.touch(mode=0o600, exist_ok=False)
    run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], root, env)
    pem = run(["openssl", "pkey", "-in", str(key), "-pubout"], root, env).decode()
    return key, pem


def sign(payload, key, root, env, run):
    message = root / "message.json"
    message.write_bytes(encode(payload))
    signature = run(
        ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(message)],
        root,
        env,
    )
    return {"payload": payload, "signature": base64.b64encode(signature).decode("ascii")}


def make_wheel(root, stdout, *, exit_code=0, setup="", startup=None):
    # Use a bounded pure-Python fixture so the canary needs no build downloads.
    root.mkdir()
    name = "mill_maintenance_probe"
    version = "1.0.0"
    info = f"{name}-{version}.dist-info"
    contents = {
        f"{name}.py": f"def main():\n{setup}    print({stdout!r})\n    return {exit_code}\n",
        f"{info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        f"{info}/WHEEL": "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        f"{info}/entry_points.txt": f"[console_scripts]\nmill-maintenance-probe = {name}:main\n",
    }
    if startup is not None:
        contents["mill-pilot-startup.pth"] = startup
    record = []
    wheel = root / f"{name}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        for filename, source in contents.items():
            body = source.encode("utf-8")
            checksum = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).decode().rstrip("=")
            record.append(f"{filename},sha256={checksum},{len(body)}\n")
            archive.writestr(zipfile.ZipInfo(filename), body)
        record.append(f"{info}/RECORD,,\n")
        archive.writestr(zipfile.ZipInfo(f"{info}/RECORD"), "".join(record))
    return wheel


def digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def wheel_digest(wheel):
    return digest(wheel.read_bytes())


def committed_blob(git, commit, selected_path):
    entry = git("ls-tree", "-z", "--full-tree", commit, "--", selected_path)
    metadata, separator, name = entry.partition(b"\t")
    fields = metadata.decode("ascii").split()
    expect(
        separator and name == selected_path.encode("utf-8") + b"\0"
        and len(fields) == 3 and fields[0] in ("100644", "100755") and fields[1] == "blob",
        "Verifier did not resolve the selected committed regular file",
    )
    mode, _, object_id = fields
    blob = git("cat-file", "blob", object_id)
    header = f"blob {len(blob)}\0".encode("ascii")
    expect(hashlib.sha1(header + blob).hexdigest() == object_id, "Verifier read a mismatched Git blob")
    return mode, blob


def run_probe(check, mode, root, env, run, *, runtime_digest=""):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = str(listener.getsockname()[1])
        python = [sys.executable, "-I", "-B", "-S", "-"]
        command = [*python, mode, str(root), port, runtime_digest]
        positive_command = [*python, "--loopback-control", str(root), port, ""]
        positive = json.loads(run(positive_command, root, env, input_bytes=check))
        expect(positive["loopbackConnect"] == "connected", "The unisolated loopback control could not connect.")
        if sys.platform == "linux":
            expect(positive["nativeSocket"] == "created", "The unisolated native socket control could not open a socket.")
        listener.settimeout(2)
        client, _ = listener.accept()
        client.close()
        if sys.platform == "darwin":
            provider = Path("/usr/bin/sandbox-exec")
            profile = "(version 1) (allow default) (deny network*)"
            isolation = {"providerDigest": digest(provider.read_bytes()), "profile": profile}
            command = [
                str(provider), "-p", profile, *command, json.dumps(isolation),
            ]
        elif sys.platform != "linux":
            raise RuntimeError("The wheel canary requires Linux seccomp or macOS sandbox-exec.")
        # Python executes this verified byte buffer via stdin. The wheel
        # subprocesses cannot rewrite a mutable script path to change it.
        return run(command, root, env, input_bytes=check)


def probe_wheel(check, wheel, root, env, run, runtime_digest):
    return json.loads(run_probe(check, str(wheel), root, env, run, runtime_digest=runtime_digest))


def verify_runtime_preflight(check, wheel, runtime, root, env, run):
    # Observe actual subprocess launch attempts in this disposable control,
    # without adding instrumentation to the signed check.
    launches = root / "runtime-preflight-processes"
    monitor = f"""
import os
from pathlib import Path
import sys


def audit_fixture_launch(event, args):
    if event != "subprocess.Popen":
        return
    executable, arguments, _, _ = args
    if "install" in arguments and "--no-index" in arguments:
        stage = "pip"
    elif Path(os.fsdecode(executable)).name == "mill-maintenance-probe":
        stage = "launcher"
    else:
        return
    with Path({str(launches)!r}).open("a", encoding="utf-8") as log:
        log.write(stage + "\\n")


sys.addaudithook(audit_fixture_launch)
""".encode("utf-8")
    monitored_check = monitor + check
    drifted = {**json.loads(runtime), "interpreterDigest": digest(b"synthetic preflight runtime drift")}
    try:
        probe_wheel(monitored_check, wheel, root, env, run, digest(encode(drifted)))
    except RuntimeError as error:
        expect("Measured runtime does not match the committed runtime" in str(error), str(error))
    else:
        raise RuntimeError("The probe accepted runtime drift.")
    expect(not launches.exists(), "Runtime drift reached pip or the installed launcher.")

    observed = probe_wheel(monitored_check, wheel, root, env, run, digest(runtime))
    expect(observed["result"] == "passed", "The matching runtime control did not pass.")
    expect(
        launches.read_text(encoding="utf-8").splitlines() == ["pip", "launcher"],
        "The matching runtime control did not observe both process launches.",
    )


def verification(request, binding, wheel, key, root, env, expected, git, run, *, reason=None):
    policy_path = binding["policyPath"]
    subject = binding["subjectCommit"]
    _, approved_policy = committed_blob(git, binding["policyCommit"], policy_path)
    _, subject_policy = committed_blob(git, subject, policy_path)
    expect(
        digest(approved_policy) == binding["policyDigest"] and approved_policy == subject_policy,
        "Verifier did not resolve the approved policy at the selected path",
    )
    policy = json.loads(approved_policy)
    expect(policy["outcomeId"] == binding["outcomeId"], "Verifier selected a different outcome")
    expect(policy["claim"] == CLAIM, "Verifier requires the canonical staging claim")
    expect(policy["reuseScope"] == "immutable-inputs", "Verifier requires immutable check inputs")
    mode, check = committed_blob(git, subject, policy["checkPath"])
    _, runtime = committed_blob(git, subject, policy["runtimePath"])
    measured_inputs = {"artifactDigest": wheel_digest(wheel), "runtimeDigest": digest(runtime)}
    verified_request = {
        "schemaVersion": "1",
        **binding,
        "inputs": {**measured_inputs, "checkDigest": digest(check), "checkMode": mode},
    }
    expect(verified_request == request, "Independent verification did not match the requested binding")

    measured = probe_wheel(check, wheel, root, env, run, measured_inputs["runtimeDigest"])
    expect(measured["inputs"] == measured_inputs, "Observed runtime or artifact changed")
    if measured["result"] != expected or measured["observationReason"] != reason:
        raise RuntimeError(f"Unexpected independent wheel result: {measured}")
    return sign(
        {
            "kind": "maintained-outcome-verification",
            "request": verified_request,
            "producedAt": timestamp(),
            "result": measured["result"],
        },
        key,
        root,
        env,
        run,
    )


def expect(condition, message):
    if not condition:
        raise RuntimeError(message)


def qualify(root, cli, run):
    home = root / "home"
    home.mkdir()
    repo = root / "repository"
    repo.mkdir()
    state = root / "state"
    git_executable = shutil.which(os.environ.get("MILL_GIT_PATH", "git"))
    if git_executable is None:
        raise RuntimeError("The wheel canary requires Git.")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "TMPDIR": str(root),
        "MILL_STATE_HOME": str(state),
        "MILL_GIT_PATH": str(Path(git_executable).resolve()),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
    }

    def git(*args):
        return run(
            [env["MILL_GIT_PATH"], "-c", "user.name=Mill outcome fixture",
             "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", *args],
            repo,
            env,
        )

    verify_process_group_cleanup(root, env, run)
    verify_launch_interruption(root, env, run)
    git("init", "--initial-branch=main", "--object-format=sha1", "--template=")
    verifier_key, verifier_public = key_pair(root, "verifier", env, run)
    owner_key, owner_public = key_pair(root, "owner", env, run)
    (repo / "evidence").mkdir()
    (repo / ".gitignore").write_text("/evidence/\n", encoding="utf-8")
    check_bytes = PROBE.read_bytes()
    (repo / CHECK).write_bytes(check_bytes)
    (repo / CHECK).chmod(0o644)
    (repo / RUNTIME).write_bytes(
        run_probe(check_bytes, "--runtime", root, env, run)
    )
    write_json(
        repo / POLICY,
        {
            "schemaVersion": "1",
            "outcomeId": "offline-wheel-cli",
            "claim": CLAIM,
            "owner": "maintainer",
            "runtimePath": RUNTIME,
            "checkPath": CHECK,
            "verifierPublicKeyPem": verifier_public,
            "ownerPublicKeyPem": owner_public,
            "maxAgeSeconds": 1800,
            "reuseScope": "immutable-inputs",
        },
    )
    git("add", ".gitignore", POLICY, RUNTIME, CHECK)
    git("commit", "-qm", "Approve the maintained wheel outcome")
    approved = git("rev-parse", "HEAD").decode().strip()
    authority = {
        "outcomeId": "offline-wheel-cli",
        "policyPath": POLICY,
        "policyCommit": approved,
        "policyDigest": digest(committed_blob(git, approved, POLICY)[1]),
    }

    def snapshot():
        return (
            git("show-ref", "--head"),
            git("status", "--porcelain=v1", "--untracked-files=all"),
            (repo / ".git/index").read_bytes(),
            (repo / ".git/config").read_bytes(),
            tuple(
                (str(file.relative_to(repo)), file.read_bytes())
                for file in sorted(repo.glob("**/*"))
                if file.is_file() and ".git" not in file.relative_to(repo).parts
            ),
        )

    def inspect(subject, wheel, *records):
        before = snapshot()
        report = json.loads(
            run(
                [*cli, "--json", "--cwd", str(repo), "handoff",
                 "--maintained-outcome", POLICY, "--policy-commit", approved,
                 "--subject", subject, "--artifact-digest", wheel_digest(wheel), *records],
                root,
                env,
            ),
        )
        expect(snapshot() == before and not state.exists(), "Handoff changed project or state")
        expect(report["ok"] is True, "Could not inspect maintained outcome")
        result = report["data"]
        expect(result["policyPath"] == POLICY, "Handoff changed the selected policy path")
        expect(result["claim"] == CLAIM, "Handoff changed the canonical staging claim")
        expect(result["authorizationGranted"] is False, "Handoff granted authority")
        expect(result["next"]["owner"] == "maintainer", "Handoff lost the decision owner")
        return result

    good = make_wheel(root / "good", '{"allocated":3}')
    renamed_good = root / "mill_maintenance_probe-1.0.0-cp399-cp399-win_amd64.whl"
    shutil.copyfile(good, renamed_good)
    expect(wheel_digest(renamed_good) == wheel_digest(good), "Rename control changed wheel bytes")
    bad = make_wheel(root / "wrong-value", '{"allocated":2}')
    duplicate = make_wheel(root / "duplicate", '{"allocated":2,"allocated":3}')
    bad_archive = root / "invalid.whl"
    bad_archive.write_bytes(b"wheel fixture without a ZIP container\n")
    bad_exit = make_wheel(root / "nonzero-exit", '{"allocated":3}', exit_code=7)
    startup_wheel = make_wheel(
        root / "startup-file", '{"allocated":3}', startup="import sys; sys.exit(9)\n",
    )
    undeclared_native = make_wheel(
        root / "undeclared-native",
        '{"allocated":3}',
        setup=(
            "    import _bz2\n"
            "    import _ctypes\n"
            "    import ctypes\n"
            "    from pathlib import Path\n"
            "    import shutil\n"
            "    copy = Path.cwd() / 'undeclared-native.so'\n"
            "    shutil.copyfile(_bz2.__file__, copy)\n"
            "    try:\n"
            "        library = ctypes.CDLL(str(copy))\n"
            "    except RuntimeError:\n"
            "        pass\n"
            "    else:\n"
            "        _ctypes.dlclose(library._handle)\n"
        ),
    )
    initial = inspect(approved, good)
    expect(initial["status"] == "unverified", "Missing proof was not unverified")
    expect(initial["next"]["action"] == "verify", "Missing proof did not request verification")
    verify_runtime_preflight(check_bytes, good, committed_blob(git, approved, RUNTIME)[1], root, env, run)
    (repo / CHECK).write_bytes(b'raise RuntimeError("The working tree check must not run")\n')
    try:
        proof = verification(
            initial["request"], {**authority, "subjectCommit": approved},
            renamed_good, verifier_key, root, env, "passed", git, run,
        )
    finally:
        (repo / CHECK).write_bytes(check_bytes)
    write_json(repo / REPORT, proof)
    verified = inspect(approved, good, "--evidence", REPORT)
    expect(verified["status"] == "current", "Passing wheel did not become current")
    expect(verified["ownerAcceptance"] == "not_recorded", "Proof inferred owner acceptance")
    expect(verified["next"]["action"] == "accept", "Current proof did not ask for acceptance")
    proof_digest = digest(encode(proof))
    expect(proof_digest == verified["verification"]["digest"], "Proof digest differs from the signed record")

    accepted = sign(
        {
            "schemaVersion": "1",
            "kind": "maintained-outcome-acceptance",
            **authority,
            "subjectCommit": approved,
            "verificationDigest": proof_digest,
            "acceptedAt": timestamp(),
        },
        owner_key,
        root,
        env,
        run,
    )
    write_json(repo / ACCEPTANCE, accepted)
    records = ["--evidence", REPORT, "--acceptance", ACCEPTANCE]
    decision = inspect(approved, good, *records)
    expect(
        decision["ownerAcceptance"] == "accepted",
        "Owner signature did not accept the exact proof and subject",
    )
    expect(decision["next"]["action"] == "none", "Accepted proof still needs a decision")

    (repo / "README.md").write_text("# Fixture notes\n", encoding="utf-8")
    git("add", "README.md")
    git("commit", "-qm", "Update unrelated notes")
    latest = git("rev-parse", "HEAD").decode().strip()
    same_inputs = inspect(latest, good, *records)
    expect(same_inputs["status"] == "current", "Unchanged inputs lost current evidence")
    expect(same_inputs["ownerAcceptance"] == "stale", "Owner decision carried across revisions")

    def recheck_failure(wheel, report, reason):
        changed = inspect(latest, wheel, *records)
        expect(changed["status"] == "stale", "Changed wheel kept old verification current")
        expect(changed["changedInputs"] == ["artifact"], "Handoff did not identify the changed artifact")
        expect(changed["next"]["action"] == "verify", "Changed artifact did not request a recheck")
        failed = verification(
            changed["request"], {**authority, "subjectCommit": latest},
            wheel, verifier_key, root, env, "failed", git, run, reason=reason,
        )
        write_json(repo / report, failed)
        latest_failure = inspect(latest, wheel, "--evidence", report, "--acceptance", ACCEPTANCE)
        expect(latest_failure["status"] == "failed", "Failing wheel did not report a verified failure")
        expect(latest_failure["next"]["action"] == "review-failure", "No owner review proposed after failure")
        expect(latest_failure["ownerAcceptance"] != "accepted", "Old decision accepted failed verification")

    recheck_failure(bad, FAILED_REPORT, "unexpected-cli-json")
    recheck_failure(duplicate, DUPLICATE_REPORT, "duplicate-json-member")
    recheck_failure(bad_archive, INSTALL_REPORT, "wheel-install-refused")
    recheck_failure(bad_exit, INVOCATION_REPORT, "cli-nonzero-exit")

    def recheck_rejection(wheel, errors):
        rejected = inspect(latest, wheel, *records)
        expect(rejected["status"] == "stale", "The rejection control must require new verification")
        previous_signature_input = (root / "message.json").read_bytes()
        try:
            verification(
                rejected["request"], {**authority, "subjectCommit": latest},
                wheel, verifier_key, root, env, "passed", git, run,
            )
        except RuntimeError as error:
            expect(all(message in str(error) for message in errors), f"Wheel control failed for another reason: {error}")
        else:
            raise RuntimeError("The verifier accepted the wheel's rejected input.")
        expect(
            (root / "message.json").read_bytes() == previous_signature_input,
            "The verifier reached the signer for a rejected input.",
        )

    recheck_rejection(
        undeclared_native,
        ["Installed CLI attempted an unapproved native load", "undeclared-native.so"],
    )
    recheck_rejection(
        startup_wheel,
        ["The wheel contains an unexpected Python startup file", "mill-pilot-startup.pth"],
    )
    with tempfile.TemporaryDirectory(prefix="space ", dir=root) as whitespace:
        try:
            verification(
                initial["request"], {**authority, "subjectCommit": approved},
                good, verifier_key, Path(whitespace), env, "passed", git, run,
            )
        except RuntimeError as error:
            expect(
                "Installed CLI requires a direct venv Python shebang" in str(error)
                and "#!/bin/sh" in str(error),
                f"Launcher trampoline control failed for another reason: {error}",
            )
        else:
            raise RuntimeError("The verifier accepted pip's launcher trampoline.")
        expect(not (Path(whitespace) / "message.json").exists(), "The trampoline reached the signer.")
    historical = inspect(approved, good, *records)
    expect(historical["verification"]["digest"] == proof_digest, "Recheck changed historical evidence")
    expect(historical["ownerAcceptance"] == "accepted", "Recheck changed the historical owner decision")
    print(
        "Maintained wheel canary passed: committed check bytes, pinned runtime dependencies, "
        "OS network denial, canonical wheel staging, installed CLI 3, "
        "same proof on unrelated commit, "
        "changed wheel stale, signed failures for wrong value, duplicate JSON, install refusal and nonzero CLI exit, "
        "unsigned undeclared CLI dependency, rejected startup file and shell trampoline, exact owner evidence"
    )


def terminate(signum, _frame):
    raise SystemExit(128 + signum)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Supply the millctl invocation, for example: node dist/cli.js")
    signal.signal(signal.SIGTERM, terminate)
    run = partial(run_command, deadline=monotonic() + PILOT_BUDGET_SECONDS)
    cli = [str(Path(argument).resolve()) if Path(argument).is_file() else argument for argument in sys.argv[1:]]
    if Path(cli[0]).name == "node":
        # Resolve the operator's selected Node before changing HOME and cwd.
        cli[0] = run([cli[0], "-p", "process.execPath"], Path.cwd(), os.environ, timeout=20).decode().strip()
    with tempfile.TemporaryDirectory(prefix="mwo-") as directory:
        qualify(Path(directory).resolve(), cli, run)
