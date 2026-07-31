#!/bin/bash
# Starts the whole ILD-OHIF-Tool stack: Colima -> Orthanc -> MONAI Label server -> OHIF v3 viewer.
# MONAI Label and the OHIF viewer are opened in their own visible Terminal.app tabs
# so you can watch their logs and Ctrl+C either one independently.
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Colima"
if ! colima status >/dev/null 2>&1; then
  colima start
else
  echo "    already running"
fi

echo "==> Orthanc"
if [ "$(docker inspect -f '{{.State.Running}}' orthanc 2>/dev/null)" = "true" ]; then
  echo "    already running"
elif docker inspect orthanc >/dev/null 2>&1; then
  docker start orthanc
else
  docker run -d --name orthanc \
    -p 8042:8042 -p 4242:4242 \
    -e DICOM_WEB_PLUGIN_ENABLED=true \
    -e ORTHANC__AUTHENTICATION_ENABLED=false \
    orthancteam/orthanc
fi

echo "==> MONAI Label server (port 8000)"
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "    already running"
else
  osascript <<EOF
tell application "Terminal"
  activate
  do script "cd '$REPO_DIR/radiology' && source ../.venv/bin/activate && python -m monailabel.main start_server --app . --studies http://localhost:8042/dicom-web --conf models nnunet_lung,nnunet_ild,sam2_lung,sam2_ild"
end tell
EOF
fi

echo "==> OHIF v3 viewer dev server (port 3002)"
if lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "    already running"
else
  osascript <<EOF
tell application "Terminal"
  activate
  do script "cd '$REPO_DIR/plugins/ohifv3/Viewers/platform/app' && NODE_ENV=development PROXY_TARGET=/proxy/dicom PROXY_DOMAIN=http://localhost:8000 PROXY_PATH_REWRITE_FROM=/proxy/dicom PROXY_PATH_REWRITE_TO=/proxy/dicom APP_CONFIG=config/monai_label.js OHIF_PORT=3002 npx webpack-dev-server --config .webpack/webpack.pwa.js"
end tell
EOF
fi

echo ""
echo "Started. Once both new Terminal tabs show they're ready, browse to:"
echo "  http://localhost:3002/ohif/"
