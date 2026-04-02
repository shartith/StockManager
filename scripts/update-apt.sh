#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
PKG_NAME="stock-manager"
DEB_FILE="/tmp/${PKG_NAME}_${VERSION}_all.deb"
APT_REPO_DIR="/tmp/apt-stockmanager"

echo "=== Stock Manager APT Repository Update ==="
echo "Version: $VERSION"
echo ""

# Step 1: Build .deb package
echo "[1/4] Building .deb package..."
bash "$SCRIPT_DIR/build-deb.sh"

if [ ! -f "$DEB_FILE" ]; then
  echo "ERROR: .deb file not found at $DEB_FILE"
  exit 1
fi

# Step 2: Clone apt repository
echo "[2/4] Cloning apt-stockmanager repository..."
rm -rf "$APT_REPO_DIR"
git clone https://github.com/shartith/apt-stockmanager.git "$APT_REPO_DIR"

# Step 3: Update repository contents
echo "[3/4] Updating repository..."
cd "$APT_REPO_DIR"

# Create directory structure
mkdir -p docs/pool/main
mkdir -p docs/dists/stable/main/binary-all

# Copy .deb file
cp "$DEB_FILE" "docs/pool/main/"

# Generate Packages index
cd docs
dpkg-scanpackages pool/main /dev/null > dists/stable/main/binary-all/Packages
gzip -9c dists/stable/main/binary-all/Packages > dists/stable/main/binary-all/Packages.gz

# Generate Release file
cd dists/stable
cat > Release << EOF
Origin: shartith
Label: Stock Manager
Suite: stable
Codename: stable
Architectures: all
Components: main
Description: Stock Manager APT Repository
Date: $(date -u '+%a, %d %b %Y %H:%M:%S UTC')
EOF

# Add checksums to Release
{
  echo "SHA256:"
  for f in main/binary-all/Packages main/binary-all/Packages.gz; do
    if [ -f "$f" ]; then
      SIZE=$(wc -c < "$f" | tr -d ' ')
      HASH=$(shasum -a 256 "$f" | awk '{print $1}')
      printf " %s %s %s\n" "$HASH" "$SIZE" "$f"
    fi
  done
} >> Release

cd "$APT_REPO_DIR"

# Step 4: Commit and push
echo "[4/4] Pushing to GitHub..."
git add -A
git commit -m "Update stock-manager to v${VERSION}" || echo "No changes to commit"
git push origin main

echo ""
echo "=== APT Repository Updated ==="
echo "Users can install with:"
echo '  echo "deb [trusted=yes] https://shartith.github.io/apt-stockmanager stable main" | sudo tee /etc/apt/sources.list.d/stock-manager.list'
echo "  sudo apt update"
echo "  sudo apt install stock-manager"
echo ""

# Cleanup
rm -rf "$APT_REPO_DIR"
