# Wallpaper Providers — Makefile
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Targets:
#   install    install the app (see scripts/install.sh)
#   uninstall  remove the app (see scripts/uninstall.sh)
#   compile    compile the GSettings schema (strict)
#   i18n       compile PO translations into in-tree MO files
#   check      syntax-gate + unit tests + schema compile (CI gate)
#   smoke      headless app smoke-test (needs main.js — P4)
#   clean      remove compiled schema and in-tree MO files

JS_FILES := $(shell find . -name '*.js' -not -path './.git/*' -not -path './build/*' | sort)
PO_FILES := $(wildcard locale/*/LC_MESSAGES/*.po)
MO_FILES := $(PO_FILES:.po=.mo)

.PHONY: install uninstall compile i18n check smoke clean

install:
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh

compile:
	glib-compile-schemas --strict schemas/

i18n: $(MO_FILES)

locale/%.mo: locale/%.po
	msgfmt $< -o $@

check:
	@echo "== node --check on all JavaScript =="
	@for f in $(JS_FILES); do \
	    node --check "$$f" || { echo "Syntax error in $$f"; exit 1; }; \
	done
	@echo "== headless unit tests =="
	GDK_BACKEND=headless gjs -m tests/run.js
	@echo "== strict schema compile =="
	$(MAKE) compile

smoke:
	GDK_BACKEND=headless gjs -m main.js --smoke-test

clean:
	rm -f schemas/gschemas.compiled
	rm -f $(MO_FILES)