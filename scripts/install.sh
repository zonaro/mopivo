#!/usr/bin/env bash
set -euo pipefail

UUID="wallpaper-providers-gnome@redclaw.com.br"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "==> Compiling schemas..."
glib-compile-schemas --strict "$SRC/schemas/"

echo "==> Installing $UUID to $DEST ..."
mkdir -p "$DEST"
cp -f "$SRC/metadata.json" "$SRC/extension.js" "$SRC/prefs.js" "$SRC/stylesheet.css" "$DEST/"
cp -rf "$SRC/lib" "$SRC/ui" "$SRC/schemas" "$SRC/locale" "$SRC/renderer" "$DEST/"

echo "==> Compiling translations..."
for po in "$DEST"/locale/*/LC_MESSAGES/*.po; do
    [ -f "$po" ] || continue
    msgfmt "$po" -o "${po%.po}.mo"
done

if command -v restorecon >/dev/null 2>&1; then
    echo "==> Fixing SELinux context..."
    restorecon -R "$DEST"
fi

echo "==> Enabling extension..."
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Enabled."
else
    echo "NOTE: shell has not picked up the extension yet (normal on first"
    echo "install: the running GNOME Shell only scans new extensions on start)."
    echo "Restart the shell, then run this script again (or just enable):"
    echo "  Wayland: log out and back in, then: gnome-extensions enable $UUID"
    echo "  X11:     Alt+F2 -> r -> Enter, then: gnome-extensions enable $UUID"
    exit 0
fi

echo ""
echo "Verify with: gnome-extensions list | grep wallhaven"
echo "Logs (Looking Glass / journal): journalctl -f -o cat /usr/bin/gnome-shell"
