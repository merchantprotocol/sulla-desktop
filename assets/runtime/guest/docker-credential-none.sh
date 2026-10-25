#!/bin/sh
# A Docker config carried over from the earlier VM names a credential helper
# that only existed there. Answer as an empty store so pulls stay anonymous.
case "$1" in
  get) cat >/dev/null; echo "credentials not found in native keychain"; exit 1 ;;
  list) echo "{}" ;;
  *) cat >/dev/null ;;
esac
