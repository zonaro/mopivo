#!/usr/bin/env bash
set -euo pipefail

APP_ID="br.com.redclaw.WallpaperProviders"
GETTEXT_DOMAIN="wallpaper-providers-gnome"

APP_DIR="$HOME/.local/share/wallpaper-providers"
DESKTOP_FILE="$HOME/.local/share/applications/$APP_ID.desktop"
ICON_FILE="$HOME/.local/share/icons/hicolor/scalable/apps/$APP_ID.svg"
SCHEMA_FILE="$HOME/.local/share/glib-2.0/schemas/$APP_ID.gschema.xml"
SCHEMA_DIR="$HOME/.local/share/glib-2.0/schemas"

echo "==> Stopping any running renderer..."
pkill -f 'renderer/renderer.js' || true

echo "==> Removing app files..."
rm -rf "$APP_DIR"

echo "==> Removing desktop entry..."
rm -f "$DESKTOP_FILE"

echo "==> Removing icon..."
rm -f "$ICON_FILE"

echo "==> Removing global schema..."
rm -f "$SCHEMA_FILE"
if [ -d "$SCHEMA_DIR" ] && command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas --strict "$SCHEMA_DIR" 2>/dev/null || true
fi

echo "==> Removing translations..."
rm -f "$HOME"/.local/share/locale/*/LC_MESSAGES/$GETTEXT_DOMAIN.mo

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo ""
echo "Uninstall complete. Removed:"
echo "  - $APP_DIR"
echo "  - $DESKTOP_FILE"
echo "  - $ICON_FILE"
echo "  - $SCHEMA_FILE"
echo "  - $HOME/.local/share/locale/*/LC_MESSAGES/$GETTEXT_DOMAIN.mo"
echo "Your wallpaper settings (org.gnome.desktop.background) were left untouched."
