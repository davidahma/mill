import os
import subprocess
import sys
from pathlib import Path

subprocess.run([sys.executable, "-I", "-B", "-m", "build", "--no-isolation", "--wheel", "--outdir", "/tmp/wheels"], check=True)
wheel = next(Path("/tmp/wheels").glob("*.whl"))
subprocess.run([sys.executable, "-I", "-B", "-m", "venv", "/tmp/package-smoke"], check=True)
python = "/tmp/package-smoke/bin/python"
subprocess.run([python, "-I", "-B", "-m", "pip", "install", "--no-index", str(wheel)], check=True)
subprocess.run([python, "-I", "-B", "-c", "from mill_python_fixture import allocate; assert allocate(3, 5) == 3"], check=True, cwd="/tmp", env={**os.environ, "PYTHONPATH": ""})
