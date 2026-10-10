#!/bin/bash
# Builds dist/Parallel Playout.pkg from the signed app in dist/mac-universal.
# Run after `npm run build:app` (or use `npm run build:pkg`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/mac-universal/Parallel Playout.app"
STAGE="$ROOT/dist/pkg-root"
OUT="$ROOT/dist/Parallel Playout.pkg"
VERSION=$(node -p "require('$ROOT/package.json').version")

[ -d "$APP" ] || { echo "Missing $APP — run npm run build:app first." >&2; exit 1; }
/usr/bin/codesign --verify --deep --strict "$APP"

rm -rf "$STAGE"
mkdir -p "$STAGE"
/usr/bin/ditto "$APP" "$STAGE/Parallel Playout.app"
chmod 755 "$ROOT/build/pkg-scripts/preinstall" "$ROOT/build/pkg-scripts/postinstall"

# Always install to /Applications, never into a copy found elsewhere.
COMPONENTS="$ROOT/dist/pkg-components.plist"
/usr/bin/pkgbuild --analyze --root "$STAGE" "$COMPONENTS" >/dev/null
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$COMPONENTS"
/usr/libexec/PlistBuddy -c "Set :0:BundleIsVersionChecked false" "$COMPONENTS"

/usr/bin/pkgbuild \
  --root "$STAGE" \
  --component-plist "$COMPONENTS" \
  --scripts "$ROOT/build/pkg-scripts" \
  --identifier com.srisathyasai.parallelplayout.pkg \
  --version "$VERSION" \
  --install-location /Applications \
  "$OUT"

rm -rf "$STAGE" "$COMPONENTS"
echo "Built $OUT"
