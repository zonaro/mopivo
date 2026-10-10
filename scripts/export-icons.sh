#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Regenerate the Mopivo icon set from the master PNG.
#
# Source of truth:
#   data/icons/br.com.redclaw.Mopivo.png   (1024x1024 RGBA, four-seasons art)
#
# Outputs:
#   data/icons/hicolor/<size>x<size>/apps/br.com.redclaw.Mopivo.png   app grid
#   docs/icon-512.png, docs/apple-touch-icon.png, docs/favicon.png    landing page
#
# Usage: scripts/export-icons.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/data/icons/br.com.redclaw.Mopivo.png"

if [ ! -f "$SRC" ]; then
    echo "ERROR: master icon missing: $SRC" >&2
    exit 1
fi

if command -v magick >/dev/null 2>&1; then
    resize() { magick "$1" -resize "${2}x${2}" -strip -define png:compression-level=9 "$3"; }
elif command -v convert >/dev/null 2>&1; then
    resize() { convert "$1" -resize "${2}x${2}" -strip -define png:compression-level=9 "$3"; }
else
    echo "ERROR: ImageMagick not found (need 'magick' or 'convert')." >&2
    exit 1
fi

# App-grid icons: a hicolor theme set so GNOME can pick a crisp size.
for size in 64 128 256 512; do
    dest="$REPO_ROOT/data/icons/hicolor/${size}x${size}/apps/br.com.redclaw.Mopivo.png"
    mkdir -p "$(dirname "$dest")"
    resize "$SRC" "$size" "$dest"
done

# Landing-page assets (GitHub Pages serves docs/).
mkdir -p "$REPO_ROOT/docs"
resize "$SRC" 512 "$REPO_ROOT/docs/icon-512.png"
resize "$SRC" 180 "$REPO_ROOT/docs/apple-touch-icon.png"
resize "$SRC" 64  "$REPO_ROOT/docs/favicon.png"

echo "Icons regenerated:"
echo "  data/icons/hicolor/{64,128,256,512}x*/apps/br.com.redclaw.Mopivo.png"
echo "  docs/icon-512.png docs/apple-touch-icon.png docs/favicon.png"
