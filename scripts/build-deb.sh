#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
PKG_NAME="stock-manager"
PKG_DIR="/tmp/${PKG_NAME}_${VERSION}_all"
DEB_FILE="/tmp/${PKG_NAME}_${VERSION}_all.deb"

echo "Building ${PKG_NAME} v${VERSION} .deb package..."

# Clean previous build
rm -rf "$PKG_DIR" "$DEB_FILE"

# Build the project
cd "$PROJECT_ROOT"
npm install --production=false
npm run build
npm prune --production

# Create package structure
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/usr/lib/stock-manager"
mkdir -p "$PKG_DIR/usr/bin"

# Copy application files
cp -r "$PROJECT_ROOT/bin" "$PKG_DIR/usr/lib/stock-manager/"
cp -r "$PROJECT_ROOT/server/dist" "$PKG_DIR/usr/lib/stock-manager/server-dist"
cp -r "$PROJECT_ROOT/client/dist" "$PKG_DIR/usr/lib/stock-manager/client-dist"
cp "$PROJECT_ROOT/package.json" "$PKG_DIR/usr/lib/stock-manager/"

# Copy node_modules (production only)
cp -r "$PROJECT_ROOT/node_modules" "$PKG_DIR/usr/lib/stock-manager/" 2>/dev/null || true
cp -r "$PROJECT_ROOT/server/node_modules" "$PKG_DIR/usr/lib/stock-manager/server-node_modules" 2>/dev/null || true

# Create wrapper script
cat > "$PKG_DIR/usr/bin/stock-manager" << 'WRAPPER'
#!/bin/bash
export STOCK_MANAGER_DATA="${HOME}/.stock-manager"
mkdir -p "$STOCK_MANAGER_DATA"
exec node /usr/lib/stock-manager/bin/stock-manager "$@"
WRAPPER
chmod 755 "$PKG_DIR/usr/bin/stock-manager"

# Create DEBIAN/control
cat > "$PKG_DIR/DEBIAN/control" << EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Architecture: all
Depends: nodejs (>= 18)
Maintainer: shartith <shartith@users.noreply.github.com>
Homepage: https://github.com/shartith/StockManager
Section: finance
Priority: optional
Description: Stock portfolio management and automated trading system
 KIS API integration, MLX (Apple Silicon) LLM trading decisions,
 automated scheduling, and web-based trading platform.
EOF

# Create DEBIAN/postinst
cat > "$PKG_DIR/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
set -e

# Create symlinks for server module resolution
APP_DIR="/usr/lib/stock-manager"

# Link server dist
if [ -d "$APP_DIR/server-dist" ]; then
  mkdir -p "$APP_DIR/server/dist"
  ln -sf "$APP_DIR/server-dist/"* "$APP_DIR/server/dist/" 2>/dev/null || cp -r "$APP_DIR/server-dist/"* "$APP_DIR/server/dist/"
fi

# Link client dist
if [ -d "$APP_DIR/client-dist" ]; then
  mkdir -p "$APP_DIR/client/dist"
  ln -sf "$APP_DIR/client-dist/"* "$APP_DIR/client/dist/" 2>/dev/null || cp -r "$APP_DIR/client-dist/"* "$APP_DIR/client/dist/"
fi

# Link server node_modules
if [ -d "$APP_DIR/server-node_modules" ]; then
  mkdir -p "$APP_DIR/server"
  ln -sf "$APP_DIR/server-node_modules" "$APP_DIR/server/node_modules" 2>/dev/null || true
fi

echo ""
echo "  Stock Manager v${VERSION} installed!"
echo "  Run: stock-manager"
echo "  Then open: http://localhost:3000"
echo ""
POSTINST
chmod 755 "$PKG_DIR/DEBIAN/postinst"

# Create DEBIAN/prerm
cat > "$PKG_DIR/DEBIAN/prerm" << 'PRERM'
#!/bin/bash
set -e
# Clean up symlinks
rm -rf /usr/lib/stock-manager/server/dist
rm -rf /usr/lib/stock-manager/client/dist
rm -rf /usr/lib/stock-manager/server/node_modules
rmdir /usr/lib/stock-manager/server 2>/dev/null || true
rmdir /usr/lib/stock-manager/client 2>/dev/null || true
PRERM
chmod 755 "$PKG_DIR/DEBIAN/prerm"

# Build .deb
dpkg-deb --build "$PKG_DIR" "$DEB_FILE" 2>/dev/null || dpkg-deb --build --root-owner-group "$PKG_DIR" "$DEB_FILE"

echo ""
echo "Package built: $DEB_FILE"
echo "Size: $(du -h "$DEB_FILE" | cut -f1)"
echo ""
echo "Install with: sudo dpkg -i $DEB_FILE"

# Clean up build directory
rm -rf "$PKG_DIR"
