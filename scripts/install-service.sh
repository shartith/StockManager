#!/bin/bash
# Stock Manager 자동 시작 서비스 설치 (Mac: launchd, Linux: systemd)

set -e

STOCK_MANAGER_BIN=$(which stock-manager 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)/bin/stock-manager")
NODE_BIN=$(which node)

if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: launchd
  PLIST="$HOME/Library/LaunchAgents/com.stockmanager.daemon.plist"

  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.stockmanager.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${STOCK_MANAGER_BIN}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.stock-manager/stock-manager.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.stock-manager/stock-manager.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STOCK_MANAGER_DATA</key>
    <string>${HOME}/.stock-manager</string>
  </dict>
</dict>
</plist>
EOF

  launchctl load "$PLIST" 2>/dev/null || true
  echo "macOS launchd 서비스 설치 완료"
  echo "  자동 시작: 로그인 시"
  echo "  자동 재시작: 크래시 시"
  echo "  제거: launchctl unload $PLIST"

elif [[ "$OSTYPE" == "linux"* ]]; then
  # Linux: systemd (user service)
  SERVICE_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_DIR"

  cat > "$SERVICE_DIR/stock-manager.service" << EOF
[Unit]
Description=Stock Manager Auto Trading
After=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${STOCK_MANAGER_BIN} run
Restart=always
RestartSec=10
Environment=STOCK_MANAGER_DATA=${HOME}/.stock-manager

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable stock-manager
  systemctl --user start stock-manager
  echo "Linux systemd 서비스 설치 완료"
  echo "  자동 시작: 부팅 시"
  echo "  자동 재시작: 크래시 10초 후"
  echo "  상태: systemctl --user status stock-manager"
  echo "  제거: systemctl --user disable stock-manager"
fi
