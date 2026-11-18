"""Produce a Mill v1 receipt with Python and OpenSSL 3."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def canonical(value):
    """Encode the strings, objects and arrays admitted by receipt v1."""
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        return "{" + ",".join(
            canonical(key) + ":" + canonical(value[key]) for key in keys
        ) + "}"
    if isinstance(value, list):
        return "[" + ",".join(map(canonical, value)) + "]"
    if not isinstance(value, str):
        raise ValueError("v1 receipts use strings, arrays and objects")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sign_receipt(payload, key):
    for report in payload["reports"]:
        report["digest"] = "sha256:" + hashlib.sha256(
            report["content"].encode("utf-8")
        ).hexdigest()
    with tempfile.TemporaryDirectory(prefix="mill-receipt-") as directory:
        message = Path(directory) / "message"
        message.write_bytes(canonical(payload).encode("utf-8"))
        signature = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(message)],
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
    return {"payload": payload, "signature": base64.b64encode(signature).decode("ascii")}


if __name__ == "__main__":
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    json.dump(sign_receipt(payload, sys.argv[2]), sys.stdout, ensure_ascii=False, indent=2)
    print()
