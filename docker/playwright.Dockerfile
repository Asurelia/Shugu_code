# Shugu Forge — Atelier sandbox image.
#
# The agent builds a web UI in a throwaway mirror, then writes a `node` script
# that drives a REAL Chromium (clicks buttons, asserts the DOM) and exits non-zero
# on failure. That run happens with the container OFFLINE (`--network none`), so
# everything it needs must be baked in HERE.
#
# Base: the official Playwright image ships Chromium/Firefox/WebKit + all OS deps,
# version-pinned (browser revisions match the tag). It does NOT ship the
# Playwright npm package, and `--network none` forbids `npm install` at run time —
# so we install the library ONCE here, into a fixed dir, and point NODE_PATH at it.
# An agent script in /work can then `require('playwright')` and find the browsers
# under /ms-playwright (the image's PLAYWRIGHT_BROWSERS_PATH).
#
# Build ONCE (the only online step):
#   docker build -t shugu-playwright:1.60 -f docker/playwright.Dockerfile docker
#
# The Playwright library version MUST match the base image tag, otherwise it
# cannot locate the pre-baked browser executables.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

RUN mkdir -p /opt/pw \
 && cd /opt/pw \
 && npm init -y >/dev/null 2>&1 \
 && npm install playwright@1.60.0 @playwright/test@1.60.0

# Resolve `require('playwright')` from any cwd (the agent's script lives in /work).
ENV NODE_PATH=/opt/pw/node_modules
WORKDIR /work
