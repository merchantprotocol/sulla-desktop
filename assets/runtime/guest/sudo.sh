#!/bin/sh
# The guest has one privilege level. Accept and drop sudo's own options so
# "sudo -E cmd" and friends run cmd unchanged.
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -u|-g|-C|-D|-p|-h) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec "$@"
