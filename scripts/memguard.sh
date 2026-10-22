#!/usr/bin/env bash
# Run a command with a hard memory cap so one runaway job cannot take the machine down.
# Usage: scripts/memguard.sh [--max 2G] [--min-free-mb 1500] -- <command...>
# Refuses to start if free memory is already low. Caps Node heap at 1 GB unless NODE_OPTIONS is set.
set -euo pipefail

MAX="2G"
MIN_FREE_MB=1500
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    --min-free-mb) MIN_FREE_MB="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[[ $# -gt 0 ]] || { echo "memguard: no command given" >&2; exit 2; }

avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
avail_mb=$((avail_kb / 1024))
if (( avail_mb < MIN_FREE_MB )); then
  echo "memguard: only ${avail_mb} MB free (< ${MIN_FREE_MB} MB). Not starting: $*" >&2
  exit 75
fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}"

if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope -q -p MemoryMax=16M true 2>/dev/null; then
  exec systemd-run --user --scope -q -p MemoryMax="$MAX" -p MemorySwapMax=0 -- "$@"
else
  echo "memguard: systemd-run unavailable, running with heap cap only" >&2
  exec "$@"
fi
