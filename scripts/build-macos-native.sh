#!/bin/bash
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

# Builds, signs and verifies Sulla Desktop's native macOS pieces.
#
# Usage (stable interface; .github/workflows/macos-native.yml and scripts/package.ts call it):
#   scripts/build-macos-native.sh <outDir> [--sign "Developer ID Application: … (TEAMID)" --profile-app <path> --profile-fp <path>]
#
# Produces in <outDir>:
#   SullaFinderSync.appex         -> Sulla Desktop.app/Contents/PlugIns/
#   SullaFileProvider.appex       -> Sulla Desktop.app/Contents/PlugIns/ (embedded.provisionprofile inside when --profile-fp)
#   SullaFileProviderHelper       -> Sulla Desktop.app/Contents/MacOS/  (must sit in MacOS so Bundle.main is the app)
#   entitlements/*.plist          the exact entitlements each product was signed with
#
# Without --sign everything is ad-hoc signed (dev builds); profiles need --sign.
# --sign takes a keychain identity name or SHA-1. Signing is inside-out with
# --options runtime --timestamp. Optional environment:
#   SULLA_NATIVE_ARCHS       architectures to build (default "arm64 x86_64")
#   SULLA_CODESIGN_KEYCHAIN  keychain holding the identity (CI temporary keychain)
# Profiles are read from the given paths only; never commit them.
set -euo pipefail

usage() { sed -n '2,8p' "$0" >&2; exit 2; }
die() { echo "build-macos-native: $*" >&2; exit 1; }

[[ $# -ge 1 ]] || usage
OUT="$1"; shift
SIGN=""; PROFILE_APP=""; PROFILE_FP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sign) [[ $# -ge 2 ]] || usage; SIGN="$2"; shift 2 ;;
    --profile-app) [[ $# -ge 2 ]] || usage; PROFILE_APP="$2"; shift 2 ;;
    --profile-fp) [[ $# -ge 2 ]] || usage; PROFILE_FP="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || die "macOS is required"
[[ -z "$SIGN" && ( -n "$PROFILE_APP" || -n "$PROFILE_FP" ) ]] && die "provisioning profiles require --sign"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ARCHS="${SULLA_NATIVE_ARCHS:-arm64 x86_64}"
GROUP_SUFFIX="io.sulla.desktop"
WORK="$OUT/.work"
rm -rf "$WORK" "$OUT/SullaFinderSync.appex" "$OUT/SullaFileProvider.appex" "$OUT/SullaFileProviderHelper" "$OUT/entitlements"
mkdir -p "$WORK" "$OUT/entitlements"
trap 'rm -rf "$WORK"' EXIT
PLISTBUDDY=/usr/libexec/PlistBuddy

TEAM=""
if [[ "$SIGN" =~ \(([A-Z0-9]{10})\)$ ]]; then TEAM="${BASH_REMATCH[1]}"; fi

# --- profiles -----------------------------------------------------------------
# Decodes a profile and checks team, application identifier and app group.
check_profile() { # <path> <bundle id suffix> <decoded plist out>
  local profile="$1" bundle="$2" decoded="$3" team appid groups
  [[ -f "$profile" ]] || die "profile not found: $profile"
  /usr/bin/security cms -D -i "$profile" > "$decoded" 2>/dev/null || die "cannot decode profile: $profile"
  team="$("$PLISTBUDDY" -c 'Print :TeamIdentifier:0' "$decoded")"
  appid="$("$PLISTBUDDY" -c 'Print :Entitlements:com.apple.application-identifier' "$decoded")"
  groups="$("$PLISTBUDDY" -c 'Print :Entitlements:com.apple.security.application-groups' "$decoded" 2>/dev/null || true)"
  [[ -z "$TEAM" || "$team" == "$TEAM" ]] || die "$profile belongs to team $team, identity is $TEAM"
  TEAM="$team"
  [[ "$appid" == "$team.$bundle" ]] || die "$profile is for $appid, expected $team.$bundle"
  grep -Eq "^[[:space:]]*($team\\.$GROUP_SUFFIX|$team\\.\\*)[[:space:]]*\$" <<<"$groups" || die "$profile does not authorize app group $team.$GROUP_SUFFIX"
  echo "profile ok: $(basename "$profile") app-id=$appid expires=$("$PLISTBUDDY" -c 'Print :ExpirationDate' "$decoded")"
}
[[ -n "$PROFILE_APP" ]] && check_profile "$PROFILE_APP" "$GROUP_SUFFIX" "$WORK/profile-app.plist"
[[ -n "$PROFILE_FP" ]] && check_profile "$PROFILE_FP" "$GROUP_SUFFIX.FileProvider" "$WORK/profile-fp.plist"

# --- build --------------------------------------------------------------------
build() { # <project> <products dir>
  /usr/bin/xcodebuild -project "$1" -alltargets -configuration Release -sdk macosx \
    ARCHS="$ARCHS" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
    CONFIGURATION_BUILD_DIR="$2" OBJROOT="$WORK/obj" SYMROOT="$WORK/sym" build
}
build "$ROOT/native/SullaFinderSync/SullaFinderSync.xcodeproj" "$WORK/products"
build "$ROOT/native/SullaFileProvider/SullaFileProvider.xcodeproj" "$WORK/products"
cp -R "$WORK/products/SullaFinderSync.appex" "$WORK/products/SullaFileProvider.appex" "$WORK/products/SullaFileProviderHelper" "$OUT/"
echo "xcodebuild ok: SullaFinderSync.appex SullaFileProvider.appex SullaFileProviderHelper ($ARCHS)"

# --- entitlements -------------------------------------------------------------
cp "$ROOT/native/SullaFinderSync/SullaFinderSync/SullaFinderSync.entitlements" "$OUT/entitlements/SullaFinderSync.plist"
cp "$ROOT/native/SullaFileProvider/SullaFileProvider/SullaFileProvider.entitlements" "$OUT/entitlements/SullaFileProvider.plist"
cp "$ROOT/native/SullaFileProvider/SullaFileProviderHelper/SullaFileProviderHelper.entitlements" "$OUT/entitlements/SullaFileProviderHelper.plist"
if [[ -n "$PROFILE_FP" ]]; then
  # Restricted identifiers are only valid next to the profile that grants them.
  "$PLISTBUDDY" -c "Add :com.apple.application-identifier string $TEAM.$GROUP_SUFFIX.FileProvider" "$OUT/entitlements/SullaFileProvider.plist"
  "$PLISTBUDDY" -c "Add :com.apple.developer.team-identifier string $TEAM" "$OUT/entitlements/SullaFileProvider.plist"
  cp "$PROFILE_FP" "$OUT/SullaFileProvider.appex/Contents/embedded.provisionprofile"
fi

# --- sign (inside-out) --------------------------------------------------------
sign() { # <entitlements> <path> [extra args]
  local entitlements="$1" target="$2"; shift 2
  local args=(--force --options runtime --entitlements "$entitlements")
  if [[ -n "$SIGN" ]]; then args+=(--sign "$SIGN" --timestamp); else args+=(--sign -); fi
  if [[ -n "${SULLA_CODESIGN_KEYCHAIN:-}" ]]; then args+=(--keychain "$SULLA_CODESIGN_KEYCHAIN"); fi
  /usr/bin/codesign "${args[@]}" "$@" "$target"
}
sign "$OUT/entitlements/SullaFileProviderHelper.plist" "$OUT/SullaFileProviderHelper" --identifier io.sulla.desktop.FileProviderHelper
sign "$OUT/entitlements/SullaFinderSync.plist" "$OUT/SullaFinderSync.appex"
sign "$OUT/entitlements/SullaFileProvider.plist" "$OUT/SullaFileProvider.appex"

# --- verify -------------------------------------------------------------------
status=0
for product in SullaFileProviderHelper SullaFinderSync.appex SullaFileProvider.appex; do
  target="$OUT/$product"
  echo "== $product"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$target" || status=1
  /usr/bin/codesign -dvv "$target" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime Version|CodeDirectory)' || true
  entitlements="$(/usr/bin/codesign -d --entitlements - --xml "$target" 2>/dev/null | /usr/bin/plutil -convert xml1 -o - - 2>/dev/null || true)"
  echo "$entitlements"
  grep -q "<string>${TEAM:-946AF7TL74}.$GROUP_SUFFIX</string>" <<<"$entitlements" || { echo "missing app group entitlement" >&2; status=1; }
  if [[ "$product" == SullaFileProvider.appex && -n "$PROFILE_FP" ]]; then
    grep -q "<string>$TEAM.$GROUP_SUFFIX.FileProvider</string>" <<<"$entitlements" || { echo "missing application-identifier" >&2; status=1; }
  fi
  # Gatekeeper's verdict; without notarization a rejection here is expected.
  /usr/sbin/spctl -a -vv -t install "$target" 2>&1 || true
done
[[ $status -eq 0 ]] || die "signature verification failed"
echo "build-macos-native: ok -> $OUT"
