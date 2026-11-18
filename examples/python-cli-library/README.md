# Python CLI/library fixture

This synthetic allocation package tests the experimental Python image profile on
a CPU container.

The lockfile includes the exact verification dependencies. Prepare the image
from the pinned Dockerfile before verification. Its manifest binds the project
and lock bytes to Python 3.12.14. Use the image's actual immutable registry
digest in a reviewed adoption configuration; a mutable tag cannot authorize a
run.

`quality/test.py` checks the package's behavior. `quality/package.py` builds a
wheel and installs it into a fresh environment without network access, then
imports the installed package outside the source directory.

From the Mill source checkout, run:

```sh
npm run build
node scripts/qualify-python-oci.mjs
```

This attended canary prepares an image, uses a loopback-only temporary registry,
inspects adoption and runs the real offline OCI verifier. It then checks a
seeded defect and changed lockfile are rejected. It cleans up owned temporary
containers and directories on success; failures preserve diagnostic directories.
Image preparation accesses the public registries; verification has no network.
It never pushes Git or publishes an image to an external registry.

The result records its source state, image digest, fixture commit and bounded
coverage. It is CPU Docker evidence on that host, not full real-provider
delivery, public-alpha qualification or GPU evidence.
