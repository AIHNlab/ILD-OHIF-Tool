#!/bin/bash
# Stops the ILD-OHIF-Tool app processes (OHIF viewer + MONAI Label server).
# Orthanc and Colima are left running by default since they're lightweight
# when idle and Orthanc holds your uploaded studies. Pass --all to stop those too.
set -e

echo "==> Stopping OHIF v3 viewer dev server (port 3002)"
PID=$(lsof -tiTCP:3002 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill "$PID"
  echo "    stopped (PID $PID)"
else
  echo "    not running"
fi

echo "==> Stopping MONAI Label server (port 8000)"
PID=$(lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill "$PID"
  echo "    stopped (PID $PID)"
else
  echo "    not running"
fi

if [ "$1" = "--all" ]; then
  echo "==> Stopping Orthanc"
  docker stop orthanc >/dev/null 2>&1 && echo "    stopped" || echo "    not running"

  echo "==> Stopping Colima"
  colima stop
else
  echo ""
  echo "Orthanc + Colima left running (lightweight when idle). Pass --all to stop those too."
fi
