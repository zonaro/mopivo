# Wallpaper Providers GNOME Shell Extension — Makefile
# SPDX-License-Identifier: GPL-3.0-or-later

UUID     = wallpaper-providers-gnome@redclaw.com.br
EXTDIR   = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SOURCES  = extension.js \
           prefs.js \
           stylesheet.css \
           metadata.json \
           lib/download.js \
           lib/i18n.js \
           lib/providers/base.js \
           lib/providers/registry.js \
           lib/providers/wallhaven.js \
           lib/providers/wallhaven-client.js \
           lib/providers/pexels.js \
           lib/providers/unsplash.js \
           lib/providers/safebooru.js \
           lib/providers/pixabay.js \
           lib/providers/waifuim.js \
           lib/providers/local.js \
           lib/video/constants.js \
           lib/video/launcher.js \
           lib/video/windowManager.js \
           lib/video/wallpaper.js \
           lib/video/shellOverride.js \
           lib/video/roundedCornersEffect.js \
           lib/video/dbus.js \
           lib/video/playbackState.js \
           lib/video/autoPause.js \
           lib/video/panelMenu.js \
           lib/video/staticBlur.js \
           lib/video/ytDlp.js \
           lib/video/videoThumbs.js \
           lib/video/videoManager.js \
           ui/gallery.js \
           ui/filters.js \
           ui/prefs_helpers.js \
           ui/videoPicker.js \
           renderer/renderer.js \
           renderer/stylesheet.css \
           schemas/org.gnome.shell.extensions.wallpaper-providers-gnome.gschema.xml

.PHONY: build install enable disable clean

# Pack into a zip that GNOME expects
build: $(SOURCES)
	gnome-extensions pack --force --out-dir=./build .

# Install to local extensions dir
install: build
	mkdir -p "$(EXTDIR)"
	cp -f ./build/$(UUID).zip /tmp/$(UUID).zip
	gnome-extensions install --force /tmp/$(UUID).zip
	@echo "Installed → $(EXTDIR). Restart GNOME Shell (Alt+F2 → r / log out) to load."

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

clean:
	rm -rf ./build
