#!/usr/bin/env bash
# Mopivo — one-liner installer.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash -s -- --uninstall
#   ./install.sh [--uninstall] [--ref <branch|tag>] [--yes]
#
# Behaviour:
#   - Inside a git checkout (scripts/install.sh exists next to this file),
#     delegates to scripts/install.sh (or scripts/uninstall.sh).
#   - When piped via curl (no checkout), clones --depth 1 or downloads the
#     master tarball to a temp dir, then runs the install from there.
#
# All technical IDs use mopivo (the app was never released, so there is no
# migration/compat layer):
#   App ID: br.com.redclaw.Mopivo
set -euo pipefail

REPO="zonaro/mopivo"
DEFAULT_REF="master"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${DEFAULT_REF}"
TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${DEFAULT_REF}.tar.gz"
CLONE_URL="https://github.com/${REPO}.git"

REF="$DEFAULT_REF"
MODE="install"
ASSUME_YES=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo ".")"

usage() {
    cat <<'EOF'
Mopivo installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/install.sh | bash
  ./install.sh [options]

Options:
  --uninstall      remove Mopivo instead of installing it
  --ref <name>     branch/tag to install from when bootstrapping (default: master)
  --yes, -y        non-interactive (assume yes)
  --help, -h       show this help

What it does:
  1. Fetches the Mopivo sources (uses the local checkout when available,
     otherwise a shallow git clone or tarball download).
  2. Installs runtime files to ~/.local/share/mopivo/
  3. Compiles the GSettings schema, translations, desktop entry and icon.

Requirements: GNOME 45-50, gjs, GTK4 + libadwaita, glib-compile-schemas, msgfmt.
EOF
}

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) MODE="uninstall"; shift ;;
        --ref) REF="${2:-}"; [ -n "$REF" ] || die "--ref needs a value"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

if [ "$REF" != "$DEFAULT_REF" ]; then
    RAW_BASE="https://raw.githubusercontent.com/${REPO}/${REF}"
    TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz"
fi

have() { command -v "$1" >/dev/null 2>&1; }

check_deps() {
    local missing=()
    for cmd in gjs glib-compile-schemas msgfmt; do
        have "$cmd" || missing+=("$cmd")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        warn "missing: ${missing[*]}"
        cat >&2 <<'EOF'
Install the missing tools first. Examples:
  Fedora:      sudo dnf install gjs gtk4 libadwaita gstreamer1-plugin-gtk4 glib2-devel gettext
  Ubuntu 24+:  sudo apt install gjs gir1.2-gtk-4.0 gir1.2-adw-1 libglib2.0-bin gettext
  Arch:        sudo pacman -S gjs gtk4 libadwaita gst-plugin-gtk4 glib2 gettext
EOF
        die "unmet dependencies — aborting."
    fi
}

fetch_sources() {
    # Already inside a checkout? Use it directly.
    if [ -f "$SCRIPT_DIR/scripts/install.sh" ]; then
        echo "$SCRIPT_DIR"
        return 0
    fi
    if [ -f "./scripts/install.sh" ]; then
        echo "$(pwd)"
        return 0
    fi

    local tmpdir
    tmpdir="$(mktemp -d -t mopivo-install-XXXXXX)"
    log "fetching Mopivo (${REF}) ..."

    if have git; then
        if git clone --depth 1 --branch "$REF" "$CLONE_URL" "$tmpdir/repo" 2>/dev/null; then
            echo "$tmpdir/repo"
            return 0
        fi
        warn "git clone failed, falling back to tarball."
    fi

    local tarball="$tmpdir/mopivo.tar.gz"
    if have curl; then
        curl -fsSL "$TARBALL_URL" -o "$tarball" || die "download failed: $TARBALL_URL"
    elif have wget; then
        wget -qO "$tarball" "$TARBALL_URL" || die "download failed: $TARBALL_URL"
    else
        die "need git, curl or wget to fetch the sources."
    fi
    tar xzf "$tarball" -C "$tmpdir" || die "failed to extract tarball."
    # archive extracts to mopivo-<ref>/ — pick the first directory.
    local extracted
    extracted="$(find "$tmpdir" -maxdepth 1 -type d -name 'mopivo-*' | head -n 1)"
    [ -n "$extracted" ] || die "unexpected tarball layout."
    echo "$extracted"
}

confirm() {
    [ "$ASSUME_YES" -eq 1 ] && return 0
    # Piped via curl => no tty. Don't block; proceed with defaults.
    [ -t 0 ] || return 0
    printf '%s [Y/n] ' "$1"
    local ans
    read -r ans || true
    case "$ans" in
        [nN]*) return 1 ;;
        *) return 0 ;;
    esac
}

main() {
    if [ "$MODE" = "uninstall" ]; then
        if [ -f "$SCRIPT_DIR/scripts/uninstall.sh" ]; then
            log "uninstalling Mopivo ..."
            bash "$SCRIPT_DIR/scripts/uninstall.sh"
            return 0
        fi
        if [ -f "./scripts/uninstall.sh" ]; then
            bash "./scripts/uninstall.sh"
            return 0
        fi
        local src
        src="$(fetch_sources)"
        bash "$src/scripts/uninstall.sh"
        rm -rf "$(dirname "$src")"
        return 0
    fi

    check_deps

    log "Mopivo installer — GNOME wallpapers (images + video)"
    confirm "Install Mopivo now?" || { echo "Aborted."; exit 0; }

    local src
    src="$(fetch_sources)"
    local temp_fetch=0
    case "$src" in
        "$SCRIPT_DIR"|"$(pwd)") temp_fetch=0 ;;
        *) temp_fetch=1 ;;
    esac

    log "installing from $src ..."
    bash "$src/scripts/install.sh"

    if [ "$temp_fetch" -eq 1 ]; then
        rm -rf "$(dirname "$src")"
    fi

    cat <<'EOF'

Done! Launch "Mopivo" from the app grid, or run:
  gjs -m ~/.local/share/mopivo/main.js

Enjoy your new wallpapers.
EOF
}

main "$@"
