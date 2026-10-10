#!/usr/bin/env bash
# Mopivo — one-liner uninstaller.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh | bash
#   ./uninstall.sh [--ref <branch|tag>] [--yes]
#
# Behaviour:
#   - Inside a git checkout (scripts/uninstall.sh exists next to this file),
#     delegates to scripts/uninstall.sh.
#   - When piped via curl (no checkout), clones --depth 1 or downloads the
#     master tarball to a temp dir, then runs the uninstall from there.
set -euo pipefail

REPO="zonaro/mopivo"
DEFAULT_REF="master"
TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${DEFAULT_REF}.tar.gz"
CLONE_URL="https://github.com/${REPO}.git"

REF="$DEFAULT_REF"
ASSUME_YES=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo ".")"

usage() {
    cat <<'EOF'
Mopivo uninstaller

Usage:
  curl -fsSL https://raw.githubusercontent.com/zonaro/mopivo/master/uninstall.sh | bash
  ./uninstall.sh [options]

Options:
  --ref <name>     branch/tag to fetch from when bootstrapping (default: master)
  --yes, -y        non-interactive (assume yes)
  --help, -h       show this help

What it removes:
  - ~/.local/share/mopivo/ (APP_DIR)
  - ~/.local/share/applications/br.com.redclaw.Mopivo.desktop
  - ~/.local/share/icons/hicolor/*/apps/br.com.redclaw.Mopivo.png
  - ~/.local/share/glib-2.0/schemas/br.com.redclaw.Mopivo.gschema.xml
  - ~/.local/share/locale/*/LC_MESSAGES/mopivo.mo

Your wallpaper settings (org.gnome.desktop.background) are left untouched.
EOF
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --ref) REF="${2:-}"; [ -n "$REF" ] || die "--ref needs a value"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

if [ "$REF" != "$DEFAULT_REF" ]; then
    TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz"
fi

have() { command -v "$1" >/dev/null 2>&1; }

fetch_sources() {
    if [ -f "$SCRIPT_DIR/scripts/uninstall.sh" ]; then
        echo "$SCRIPT_DIR"
        return 0
    fi
    if [ -f "./scripts/uninstall.sh" ]; then
        echo "$(pwd)"
        return 0
    fi

    local tmpdir
    tmpdir="$(mktemp -d -t mopivo-uninstall-XXXXXX)"
    log "fetching Mopivo uninstaller (${REF}) ..."

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
    local extracted
    extracted="$(find "$tmpdir" -maxdepth 1 -type d -name 'mopivo-*' | head -n 1)"
    [ -n "$extracted" ] || die "unexpected tarball layout."
    echo "$extracted"
}

confirm() {
    [ "$ASSUME_YES" -eq 1 ] && return 0
    [ -t 0 ] || return 0
    printf '%s [y/N] ' "$1"
    local ans
    read -r ans || true
    case "$ans" in
        [yY]*) return 0 ;;
        *) return 1 ;;
    esac
}

main() {
    log "Mopivo uninstaller"
    confirm "Remove Mopivo now?" || { echo "Aborted."; exit 0; }

    local src
    src="$(fetch_sources)"
    log "uninstalling from $src ..."
    bash "$src/scripts/uninstall.sh"

    case "$src" in
        "$SCRIPT_DIR"|"$(pwd)") : ;;
        *) rm -rf "$(dirname "$src")" ;;
    esac
}

main "$@"
