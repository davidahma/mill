# Prepare explicitly. Mill never builds or pulls this image during verification.
FROM python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
RUN pip install --no-cache-dir uv==0.8.22
WORKDIR /profile
COPY pyproject.toml uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
# Qualification deliberately exercises optimization and an unsafe ambient path.
ENV PYTHONOPTIMIZE=1 PYTHONPATH=/workspace
RUN uv sync --frozen --no-install-project --group verify
RUN /opt/venv/bin/python -c "import hashlib,json,sys; from pathlib import Path; d=lambda p:'sha256:'+hashlib.sha256(Path(p).read_bytes()).hexdigest(); Path('/opt/mill-python-profile.json').write_text(json.dumps({'schemaVersion':'1','python':'.'.join(map(str,sys.version_info[:3])),'projectDigest':d('pyproject.toml'),'lockDigest':d('uv.lock')}))"
