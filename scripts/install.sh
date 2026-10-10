#!/usr/bin/env bash
set -euo pipefail

APP_ID="br.com.redclaw.Mopivo"
OLD_UUID="wallpaper-providers-gnome@redclaw.com.br"
GETTEXT_DOMAIN="mopivo"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.local/share/mopivo"

echo "==> Removing old GNOME Shell extension (if present)..."
gnome-extensions disable "$OLD_UUID" || true
gnome-extensions uninstall "$OLD_UUID" || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$OLD_UUID"

echo "==> Installing runtime files to $APP_DIR ..."
mkdir -p "$APP_DIR"

RUNTIME_ITEMS=(main.js app ui lib renderer schemas locale)
EXISTING_ITEMS=()
for item in "${RUNTIME_ITEMS[@]}"; do
    if [ -e "$REPO_ROOT/$item" ]; then
        EXISTING_ITEMS+=("$REPO_ROOT/$item")
    else
        echo "WARN: $item not found in repo, skipping."
    fi
done

if [ "${#EXISTING_ITEMS[@]}" -gt 0 ]; then
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete "${EXISTING_ITEMS[@]}" "$APP_DIR/"
    else
        echo "NOTE: rsync not found, using cp fallback."
        for item in "${RUNTIME_ITEMS[@]}"; do
            [ -e "$REPO_ROOT/$item" ] || continue
            rm -rf "$APP_DIR/$item"
            cp -a "$REPO_ROOT/$item" "$APP_DIR/$item"
        done
    fi
fi

if [ -d "$APP_DIR/schemas" ]; then
    echo "==> Compiling schema in place for the renderer loader..."
    glib-compile-schemas --strict "$APP_DIR/schemas"
fi

SCHEMA_XML="$REPO_ROOT/schemas/$APP_ID.gschema.xml"
if [ -f "$SCHEMA_XML" ]; then
    echo "==> Installing $APP_ID schema globally..."
    install -D -m644 "$SCHEMA_XML" "$HOME/.local/share/glib-2.0/schemas/"
    glib-compile-schemas --strict "$HOME/.local/share/glib-2.0/schemas"
else
    echo "WARN: $SCHEMA_XML not found, skipping global schema install."
fi

echo "==> Compiling translations..."
if command -v msgfmt >/dev/null 2>&1; then
    for po in "$REPO_ROOT"/locale/*/LC_MESSAGES/*.po; do
        [ -f "$po" ] || continue
        lang="$(basename "$(dirname "$(dirname "$po")")")"
        target_dir="$HOME/.local/share/locale/$lang/LC_MESSAGES"
        mkdir -p "$target_dir"
        msgfmt -o "$target_dir/$GETTEXT_DOMAIN.mo" "$po"
    done
else
    echo "WARN: msgfmt not found, skipping translations."
fi

DESKTOP_IN="$REPO_ROOT/data/$APP_ID.desktop.in"
DESKTOP_OUT="$HOME/.local/share/applications/$APP_ID.desktop"
if [ -f "$DESKTOP_IN" ]; then
    echo "==> Installing desktop entry..."
    mkdir -p "$(dirname "$DESKTOP_OUT")"
    sed "s|@APPDIR@|$APP_DIR|g" "$DESKTOP_IN" > "$DESKTOP_OUT"
    update-desktop-database "$HOME/.local/share/applications" || true
else
    echo "WARN: $DESKTOP_IN not found, skipping desktop entry."
fi

ICON_SRC_DIR="$REPO_ROOT/data/icons/hicolor"
ICON_DEST_DIR="$HOME/.local/share/icons/hicolor"
if [ -d "$ICON_SRC_DIR" ]; then
    echo "==> Installing icons..."
    mkdir -p "$ICON_DEST_DIR"
    cp -a "$ICON_SRC_DIR/." "$ICON_DEST_DIR/"
    gtk-update-icon-cache -f "$ICON_DEST_DIR" || true
else
    echo "WARN: $ICON_SRC_DIR not found, skipping icons."
fi

echo ""
echo "Installation complete."
echo "You can now launch \"Mopivo\" from the app grid."
