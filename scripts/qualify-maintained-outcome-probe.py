"""Install a synthetic wheel offline and observe its public CLI contract."""

import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import zipfile


def digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


NATIVE_MEASUREMENT = """
import ctypes
import hashlib
from importlib.machinery import EXTENSION_SUFFIXES
import json
import os
from pathlib import Path
import sys


DYLD_SYMBOLS = ctypes.CDLL(None) if sys.platform == "darwin" else None


def digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def native_file_digest(path, mapping=None):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        if mapping is not None:
            info = os.fstat(stream.fileno())
            identity = os.major(info.st_dev), os.minor(info.st_dev), info.st_ino
            if identity != mapping:
                raise RuntimeError("A mapped native executable changed: " + str(path))
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return "sha256:" + result.hexdigest()


def linux_native_dependencies():
    files = {}
    for entry in Path("/proc/self/maps").read_text(encoding="utf-8").splitlines():
        fields = entry.split(maxsplit=5)
        if len(fields) != 6 or "x" not in fields[1] or not fields[5].startswith("/"):
            continue
        path = Path(fields[5])
        device = tuple(int(part, 16) for part in fields[3].split(":"))
        files[path] = (*device, int(fields[4]))
    return [(str(path), native_file_digest(path, files[path])) for path in sorted(files)]


def darwin_cache_identity():
    get_cache_uuid = DYLD_SYMBOLS._dyld_get_shared_cache_uuid
    get_cache_uuid.argtypes = [ctypes.POINTER(ctypes.c_ubyte)]
    get_cache_uuid.restype = ctypes.c_bool
    cache_uuid = (ctypes.c_ubyte * 16)()
    return bytes(cache_uuid).hex() if get_cache_uuid(cache_uuid) else None


def darwin_native_dependencies():
    symbols = DYLD_SYMBOLS
    count = symbols._dyld_image_count
    count.restype = ctypes.c_uint32
    name = symbols._dyld_get_image_name
    name.argtypes = [ctypes.c_uint32]
    name.restype = ctypes.c_char_p
    header = symbols._dyld_get_image_header
    header.argtypes = [ctypes.c_uint32]
    header.restype = ctypes.c_void_p
    get_range = symbols._dyld_get_shared_cache_range
    get_range.argtypes = [ctypes.POINTER(ctypes.c_size_t)]
    get_range.restype = ctypes.c_void_p
    get_image_uuid = symbols._dyld_get_image_uuid
    get_image_uuid.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte)]
    get_image_uuid.restype = ctypes.c_bool

    cache_size = ctypes.c_size_t()
    cache_start = get_range(ctypes.byref(cache_size)) or 0
    cache_end = cache_start + cache_size.value
    cache_id = darwin_cache_identity()
    files, cached = [], []
    for index in range(count()):
        path = Path(os.fsdecode(name(index)))
        address = header(index)
        if address is None:
            raise RuntimeError("A loaded macOS native image could not be inspected.")
        if cache_start <= address < cache_end:
            image_uuid = (ctypes.c_ubyte * 16)()
            if cache_id is None or not get_image_uuid(address, image_uuid):
                raise RuntimeError("A loaded macOS shared-cache image has no identity.")
            cached.append((str(path), bytes(image_uuid).hex()))
        else:
            files.append((str(path), native_file_digest(path)))
    return sorted(files), cache_id, sorted(cached)


def native_dependencies():
    if sys.platform == "linux":
        files, cache_id, cached = linux_native_dependencies(), None, []
    elif sys.platform == "darwin":
        files, cache_id, cached = darwin_native_dependencies()
    else:
        raise RuntimeError("Native dependency measurement requires Linux or macOS.")
    if not files:
        raise RuntimeError("No file-backed native inputs were measured.")
    return {"files": files, "sharedCache": cache_id, "cachedImages": cached}


def guard_native_loads(approved, *, allow_ctypes):
    files = {Path(path).resolve(): content for path, content in approved["files"]}
    cached = {Path(path) for path, _ in approved["cachedImages"]}
    rejected = []

    def measured_file(requested):
        path = Path(os.fsdecode(requested))
        if not path.is_absolute():
            return False
        try:
            path = path.resolve(strict=True)
            return path in files and native_file_digest(path) == files[path]
        except OSError:
            return False

    def measured_cache_image(requested):
        if sys.platform != "darwin":
            return False
        path = Path(os.fsdecode(requested))
        if not path.is_absolute() or path.is_file():
            return False
        # Framework paths may resolve through an on-disk symlink. Darwin's
        # virtual libc alias also names the already-measured libSystem image.
        resolved = (
            Path("/usr/lib/libSystem.B.dylib")
            if path == Path("/usr/lib/libc.dylib")
            else path.resolve()
        )
        if resolved not in cached:
            return False
        contains = DYLD_SYMBOLS._dyld_shared_cache_contains_path
        contains.argtypes = [ctypes.c_char_p]
        contains.restype = ctypes.c_bool
        return (
            approved["sharedCache"] is not None
            and darwin_cache_identity() == approved["sharedCache"]
            and contains(os.fsencode(path))
        )

    def audit(event, args):
        if event == "ctypes.dlopen":
            requested = args[0]
            if allow_ctypes and (
                requested is None or measured_file(requested) or measured_cache_image(requested)
            ):
                return
        elif event == "import" and args[1] and args[1].endswith(tuple(EXTENSION_SUFFIXES)):
            requested = args[1]
            if measured_file(requested) or measured_cache_image(requested):
                return
        else:
            return
        rejected.append(f"{event}: {requested!r}")
        raise RuntimeError("The wheel fixture attempted an unapproved native load.")

    sys.addaudithook(audit)
    return rejected


def write_native_observation(report, rejected):
    with report.open("x", encoding="utf-8") as stream:
        json.dump({"nativeDependencies": native_dependencies(), "rejectedLoads": rejected}, stream)
"""


RUNTIME_MEASUREMENT = NATIVE_MEASUREMENT + """
import _bz2
import _lzma
import bz2
import lzma
import platform
import ssl
import sysconfig
import zlib

import pip
from pip._internal.commands import create_command


def tree_digest(root, excluded, *, installed_site=False):
    files = []

    def visit(directory):
        for path in sorted(directory.iterdir()):
            if path.name in excluded:
                continue
            if installed_site and path.name == "RECORD" and path.parent.name.endswith(".dist-info"):
                # The generated install inventory includes digests of command
                # wrappers with scratch-specific shebangs. It is not run.
                continue
            if path.is_dir():
                visit(path)
            elif path.is_file():
                files.append((path.relative_to(root).as_posix(), digest(path.read_bytes())))
            else:
                raise RuntimeError("Unmeasurable dependency: " + str(path))

    visit(root)
    return digest(json.dumps(files, separators=(",", ":")).encode("utf-8"))


stdlib = Path(sysconfig.get_path("stdlib")).resolve()
sites = {
    Path(sysconfig.get_path(category)).resolve() for category in ("purelib", "platlib")
}
pip_path = Path(pip.__file__).resolve()
if pip_path.parent.parent not in sites:
    raise RuntimeError("The measured pip module is outside the isolated venv.")
isolation = json.loads(sys.argv[1])
args = sys.argv[2:]
if args == ["--pip-location"]:
    print(pip_path.parent)
    sys.exit()
if args == ["--native-sources"]:
    print(json.dumps([_bz2.__file__, _lzma.__file__]))
    sys.exit()
create_command("install", isolated=True)
archives = []
site_digests = []
for entry in sys.path:
    path = Path(entry).resolve()
    if path in sites:
        site_digests.append(tree_digest(path, {"__pycache__"}, installed_site=True))
        continue
    if not path.exists() or path == stdlib or stdlib in path.parents:
        continue
    if not path.is_file():
        raise RuntimeError("An unexpected Python import root was not measured: " + str(path))
    archives.append((path.name, digest(path.read_bytes())))

def runtime_descriptor(native):
    return json.dumps(
        {
            "implementation": platform.python_implementation(),
            "version": platform.python_version(),
            "system": platform.system(),
            "machine": platform.machine(),
            "interpreterDigest": digest(Path(sys.executable).read_bytes()),
            "networkIsolation": isolation,
            "nativeDependencies": native,
            "stdlibDigest": tree_digest(stdlib, {"site-packages", "dist-packages"}),
            "stdlibArchives": archives,
            "pipVersion": pip.__version__,
            "sitePackagesDigests": site_digests,
        },
        sort_keys=True,
    ).encode("utf-8")


if args[:1] == ["--native-control"]:
    control_image = ctypes.CDLL(args[1])
sys.stdout.buffer.write(runtime_descriptor(native_dependencies()))
"""


PIP_INSTALLATION = NATIVE_MEASUREMENT + """
approved = json.loads(Path(sys.argv[2]).read_bytes())
rejected = guard_native_loads(approved, allow_ctypes=True)
try:
    from pip._internal.cli.main import main
    status = main(sys.argv[3:])
finally:
    write_native_observation(Path(sys.argv[1]), rejected)
sys.exit(status)
"""


LAUNCHER_OBSERVER = NATIVE_MEASUREMENT + """
import atexit

observer = Path(__file__).parent
approved = json.loads(observer.joinpath("approved-native.json").read_bytes())
rejected = guard_native_loads(approved, allow_ctypes=False)

@atexit.register
def record_launcher_dependencies():
    write_native_observation(observer / "native-dependencies.json", rejected)
"""


def venv_site_directories(venv):
    directories = {
        path.resolve()
        for pattern in ("lib*/python*/site-packages", "lib*/python*/dist-packages")
        for path in venv.glob(pattern)
        if path.is_dir()
    }
    if not directories or any(venv.resolve() not in path.parents for path in directories):
        raise RuntimeError("Could not identify private venv site-package directories.")
    return sorted(directories)


def startup_name(name):
    name = name.casefold()
    return name.endswith(".pth") or name.partition(".")[0] in {"sitecustomize", "usercustomize"}


def require_clean_startup(venv):
    for site in venv_site_directories(venv):
        for path in sorted(site.iterdir()):
            if startup_name(path.name):
                raise RuntimeError(f"The venv contains an unexpected Python startup file: {path.name}")


def require_clean_wheel_inventory(wheel):
    try:
        with zipfile.ZipFile(wheel) as archive:
            for name in archive.namelist():
                if any(startup_name(part) for part in PurePosixPath(name).parts):
                    raise RuntimeError(f"The wheel contains an unexpected Python startup file: {name}")
    except zipfile.BadZipFile:
        # Keep the independent pip refusal observation for malformed wheels.
        return


def prepare_venv(root):
    # Redirect cache reads away from any package bytecode installed by
    # ensurepip. -B also prevents creation in the unused cache location.
    flags = ["-I", "-B", "-X", f"pycache_prefix={root / 'unused-bytecode'}"]
    venv = root / "v"
    subprocess.run(
        [sys.executable, *flags, "-S", "-m", "venv", str(venv)],
        check=True,
        env={**os.environ, "PIP_CONFIG_FILE": os.devnull},
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    # Python 3.11 ensurepip can seed a setuptools startup hook. The
    # controlled wheel check does not use it.
    for site in venv_site_directories(venv):
        (site / "distutils-precedence.pth").unlink(missing_ok=True)
    require_clean_startup(venv)
    return [str(venv / "bin" / "python"), *flags]


def measure_runtime(python, isolation, *args):
    return subprocess.check_output(
        [*python, "-c", RUNTIME_MEASUREMENT, json.dumps(isolation), *args],
        stdin=subprocess.DEVNULL,
    ).strip()


def expected_runtime(scratch, isolation):
    with tempfile.TemporaryDirectory(prefix="rt-", dir=scratch) as directory:
        root = Path(directory).resolve()
        python = prepare_venv(root)
        native_path = root / "native-control.so"
        control_digests = []
        control_descriptors = []
        for source in json.loads(measure_runtime(python, isolation, "--native-sources")):
            shutil.copyfile(source, native_path)
            descriptor = measure_runtime(python, isolation, "--native-control", str(native_path))
            files = dict(json.loads(descriptor)["nativeDependencies"]["files"])
            copied_digest = digest(native_path.read_bytes())
            if files.get(str(native_path)) != copied_digest:
                raise RuntimeError("The native control did not discover the loaded scratch image.")
            control_digests.append(copied_digest)
            control_descriptors.append(digest(descriptor))
        if len(set(control_digests)) != 2 or len(set(control_descriptors)) != 2:
            raise RuntimeError("The runtime identity missed a same-path native dependency change.")
        original = measure_runtime(python, isolation)
        changed_provider = {**isolation, "providerDigest": digest(b"synthetic isolation provider drift")}
        changed_runtime = measure_runtime(python, changed_provider)
        if (
            json.loads(original).get("networkIsolation") != isolation
            or json.loads(changed_runtime).get("networkIsolation") != changed_provider
            or digest(original) == digest(changed_runtime)
        ):
            raise RuntimeError("The runtime identity missed an isolation provider change.")
        pip_path = Path(os.fsdecode(measure_runtime(python, isolation, "--pip-location")))
        dependency = (pip_path / "_internal" / "cli" / "main.py").resolve(strict=True)
        if root not in dependency.parents:
            raise RuntimeError("The runtime control must only alter its disposable environment.")
        with dependency.open("ab") as stream:
            stream.write(b"\n# Mill same-version runtime dependency control.\n")
        changed = measure_runtime(python, isolation)
        before, after = json.loads(original), json.loads(changed)
        if (
            before["pipVersion"] != after["pipVersion"]
            or before["sitePackagesDigests"] == after["sitePackagesDigests"]
        ):
            raise RuntimeError("The runtime identity missed a same-version pip dependency change.")
        return original


def linux_isolation_provider(symbol):
    address = ctypes.cast(symbol, ctypes.c_void_p).value
    for entry in Path("/proc/self/maps").read_text(encoding="utf-8").splitlines():
        fields = entry.split(maxsplit=5)
        if len(fields) != 6 or "x" not in fields[1] or not fields[5].startswith("/"):
            continue
        start, end = (int(part, 16) for part in fields[0].split("-"))
        if not start <= address < end:
            continue
        provider = Path(fields[5])
        major, minor = (int(part, 16) for part in fields[3].split(":"))
        with provider.open("rb") as stream:
            info = os.fstat(stream.fileno())
            if (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino) != (major, minor, int(fields[4])):
                raise RuntimeError("The mapped isolation provider changed.")
            return {"providerPath": str(provider), "providerDigest": digest(stream.read())}
    raise RuntimeError("Could not identify the mapped libseccomp provider.")


def deny_linux_sockets(scratch):
    # No inherited sockets are open. Block new sockets and the alternate
    # io_uring route for this process and all of its descendants.
    try:
        seccomp = ctypes.CDLL("libseccomp.so.2")
    except OSError as error:
        raise RuntimeError("The Linux wheel canary requires libseccomp.so.2.") from error
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
    ]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.restype = None

    allow = 0x7FFF0000  # SCMP_ACT_ALLOW
    reject = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO(EPERM)
    blocked = ["socket", "socketpair", "io_uring_setup"]
    provider = linux_isolation_provider(seccomp.seccomp_load)
    context = seccomp.seccomp_init(allow)
    if not context:
        raise RuntimeError("Could not initialize the wheel canary seccomp filter.")
    try:
        for name in blocked:
            syscall = seccomp.seccomp_syscall_resolve_name(name.encode("ascii"))
            if syscall == -1 or seccomp.seccomp_rule_add(context, reject, syscall, 0) != 0:
                raise RuntimeError(f"Could not restrict {name} in the wheel canary.")
        with tempfile.TemporaryFile(dir=scratch) as exported:
            if seccomp.seccomp_export_bpf(context, exported.fileno()) != 0:
                raise RuntimeError("Could not measure the wheel canary seccomp filter.")
            exported.seek(0)
            filter_bytes = exported.read()
            if not filter_bytes:
                raise RuntimeError("The wheel canary seccomp filter is empty.")
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError("Could not load the wheel canary seccomp filter.")
    finally:
        seccomp.seccomp_release(context)
    return {
        "provider": "linux-seccomp",
        **provider,
        "filterDigest": digest(filter_bytes),
        "deniedSyscalls": blocked,
        "deniedErrno": errno.EPERM,
    }


def darwin_isolation(launch):
    provider = Path("/usr/bin/sandbox-exec")
    actual_digest = digest(provider.read_bytes())
    if actual_digest != launch["providerDigest"]:
        raise RuntimeError("The macOS isolation provider changed during launch.")
    return {
        "provider": "darwin-sandbox-exec",
        "providerPath": str(provider),
        "providerDigest": actual_digest,
        "profile": launch["profile"],
    }


def observe_loopback(port):
    # Exercise a child, as both pip and the installed CLI run as children.
    # The harness keeps a live listener on this exact loopback port.
    attempt = """
import ctypes
import errno
import json
import os
import socket
import sys

observed = {}
if sys.platform == "linux":
    native_socket = ctypes.CDLL(None, use_errno=True).socket
    descriptor = native_socket(socket.AF_INET, socket.SOCK_STREAM, 0)
    if descriptor >= 0:
        os.close(descriptor)
        observed["nativeSocket"] = "created"
    elif ctypes.get_errno() == errno.EPERM:
        observed["nativeSocket"] = "EPERM"
    else:
        raise OSError(ctypes.get_errno(), "Native socket control failed unexpectedly.")

try:
    with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=2):
        observed["loopbackConnect"] = "connected"
except PermissionError:
    observed["loopbackConnect"] = "permission-denied"
print(json.dumps(observed))
"""
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-S", "-c", attempt, str(port)],
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(
            "Wheel canary could not observe loopback: "
            + result.stderr.decode("utf-8", errors="replace").strip()
        )
    return json.loads(result.stdout)


def require_network_denial(port):
    observed = observe_loopback(port)
    if observed["loopbackConnect"] != "permission-denied" or (
        sys.platform == "linux" and observed["nativeSocket"] != "EPERM"
    ):
        raise RuntimeError("Wheel canary could not prove OS network denial.")
    return observed


class DuplicateJsonMember(ValueError):
    pass


def unique_json_object(members):
    result = {}
    for name, value in members:
        if name in result:
            raise DuplicateJsonMember(name)
        result[name] = value
    return result


def reject_json_constant(value):
    raise ValueError(value)


def observe_stdout(stdout):
    try:
        return json.loads(
            stdout.decode("utf-8"),
            object_pairs_hook=unique_json_object,
            parse_constant=reject_json_constant,
        ), None
    except DuplicateJsonMember:
        return None, "duplicate-json-member"
    except ValueError:
        return None, "invalid-json"


def require_measured_native_dependencies(approved, observed, stage):
    if (
        observed["sharedCache"] != approved["sharedCache"]
        or any(file not in approved["files"] for file in observed["files"])
        or any(image not in approved["cachedImages"] for image in observed["cachedImages"])
    ):
        raise RuntimeError(
            f"{stage} loaded a native dependency outside the verified runtime: "
            + repr([file for file in observed["files"] if file not in approved["files"]])
            + repr([image for image in observed["cachedImages"] if image not in approved["cachedImages"]])
        )


def require_native_observation(approved, path, stage):
    observed = json.loads(path.read_bytes())
    if observed["rejectedLoads"]:
        raise RuntimeError(f"{stage} attempted an unapproved native load: {observed['rejectedLoads']!r}")
    require_measured_native_dependencies(approved, observed["nativeDependencies"], stage)


def require_direct_launcher(launcher, interpreter):
    executable = os.fsencode(interpreter)
    expected = b"#!" + executable + b"\n"
    with launcher.open("rb") as stream:
        shebang = stream.readline(len(expected) + 1)
    if len(executable.split()) != 1 or shebang != expected or not os.access(launcher, os.X_OK):
        raise RuntimeError(f"Installed CLI requires a direct venv Python shebang; observed {shebang.rstrip()!r}.")


def install_and_observe(wheel, python, root, runtime):
    interpreter = Path(python[0])
    venv = interpreter.parent.parent
    require_clean_startup(venv)
    approved_native = json.loads(runtime)["nativeDependencies"]
    observer = root / "launcher-observer"
    observer.mkdir(mode=0o700)
    approved_record = observer / "approved-native.json"
    approved_record.write_text(json.dumps(approved_native), encoding="utf-8")
    approved_record.chmod(0o400)
    native_record = root / "pip-native-dependencies.json"
    installation = subprocess.run(
        [
            *python, "-c", PIP_INSTALLATION, str(native_record), str(approved_record), "--isolated",
            "--disable-pip-version-check", "install", "--no-index",
            "--no-deps", "--no-cache-dir", "--no-compile", str(wheel),
        ],
        env={**os.environ, "PIP_CONFIG_FILE": os.devnull},
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    if not native_record.is_file():
        installation.check_returncode()
        raise RuntimeError("Pip did not report its loaded native dependencies.")
    require_native_observation(approved_native, native_record, "Pip")
    if installation.returncode:
        # Confirm both the negative artifact and pip's specific diagnosis.
        # Other install failures might be verifier infrastructure faults.
        invalid_wheel = any(
            line.startswith(b"ERROR: Wheel ") and line.endswith(b" is invalid.")
            for line in installation.stderr.splitlines()
        )
        if installation.returncode == 1 and invalid_wheel and not zipfile.is_zipfile(wheel):
            return None, "wheel-install-refused"
        installation.check_returncode()

    require_clean_startup(venv)
    launcher = interpreter.with_name("mill-maintenance-probe")
    require_direct_launcher(launcher, interpreter)
    recorder = observer / "sitecustomize.py"
    recorder.write_text(LAUNCHER_OBSERVER, encoding="utf-8")
    recorder.chmod(0o400)
    installed = subprocess.run(
        [str(launcher)],
        cwd=root,
        env={
            **os.environ,
            "PYTHONPATH": str(observer),
            "PYTHONPYCACHEPREFIX": str(root / "unused-bytecode"),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONSAFEPATH": "1",
        },
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    launcher_record = observer / "native-dependencies.json"
    if not launcher_record.is_file():
        raise RuntimeError("Installed CLI did not report its loaded native dependencies.")
    require_native_observation(approved_native, launcher_record, "Installed CLI")
    observed, issue = observe_stdout(installed.stdout)
    expected_stdout = (
        issue is None
        and isinstance(observed, dict)
        and type(observed.get("allocated")) is int
        and observed == {"allocated": 3}
    )
    if installed.returncode:
        if installed.returncode == 7 and expected_stdout:
            return observed, "cli-nonzero-exit"
        # Only the seeded entry point's deliberate exit is a fixture result.
        installed.check_returncode()
    if issue is not None:
        return observed, issue
    if expected_stdout:
        return observed, None
    return observed, "unexpected-cli-json"


def check_wheel(path, scratch, isolation, expected_runtime_digest):
    wheel_bytes = path.read_bytes()
    with tempfile.TemporaryDirectory(prefix="p-", dir=scratch) as directory:
        root = Path(directory).resolve()
        wheel = root / "mill_maintenance_probe-1.0.0-py3-none-any.whl"
        wheel.write_bytes(wheel_bytes)
        require_clean_wheel_inventory(wheel)
        python = prepare_venv(root)
        runtime = measure_runtime(python, isolation)
        runtime_digest = digest(runtime)
        if runtime_digest != expected_runtime_digest:
            raise RuntimeError("Measured runtime does not match the committed runtime. Wheel execution stopped.")
        observed, reason = install_and_observe(wheel, python, root, runtime)
    return {
        "inputs": {
            "artifactDigest": digest(wheel_bytes),
            "runtimeDigest": runtime_digest,
        },
        "result": "passed" if reason is None else "failed",
        "observed": observed,
        "observationReason": reason,
    }


if __name__ == "__main__":
    mode, directory, port, expected_runtime_digest, *launch = sys.argv[1:]
    if mode == "--loopback-control":
        print(json.dumps(observe_loopback(int(port))))
        sys.exit()
    scratch = Path(directory)
    if sys.platform == "linux":
        isolation = deny_linux_sockets(scratch)
    elif sys.platform == "darwin" and len(launch) == 1:
        isolation = darwin_isolation(json.loads(launch[0]))
    else:
        raise RuntimeError("The probe did not receive the expected isolation provider.")
    isolation["kernelRelease"] = os.uname().release
    isolation["negativeControl"] = require_network_denial(int(port))
    if mode == "--runtime":
        sys.stdout.buffer.write(expected_runtime(scratch, isolation))
    else:
        print(json.dumps(check_wheel(Path(mode), scratch, isolation, expected_runtime_digest)))
