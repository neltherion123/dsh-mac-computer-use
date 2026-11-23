#!/bin/bash
# Build the task-scoped preview on macOS.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$here/bin"
clang -O2 -fobjc-arc -mmacosx-version-min=13.0 \
  -o "$here/bin/dsh-mac-cua-hud" \
  "$here/hud/HUD.m" \
  -framework Cocoa -framework QuartzCore
codesign --force --sign - "$here/bin/dsh-mac-cua-hud" >/dev/null
echo "built $here/bin/dsh-mac-cua-hud"
