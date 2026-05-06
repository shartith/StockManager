#!/usr/bin/env bash
# Multi-arch (linux/amd64, linux/arm64) build & push to Docker Hub.
#
#   ./scripts/build-docker.sh                  # tag = package.json version + :latest
#   ./scripts/build-docker.sh 5.2.0            # explicit version tag
#   ./scripts/build-docker.sh --no-push        # local test build (single arch, load into daemon)
#
# Prerequisites:
#   - docker login                             # Docker Hub creds for shartith0106
#   - docker buildx                            # ships with Docker Desktop

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="shartith0106/stock-manager"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER="stock-manager-builder"

NO_PUSH=0
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --no-push) NO_PUSH=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) VERSION="$arg" ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('./package.json').version")"
fi

# Buildx builder (multi-arch capable; reused across runs)
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "▶ creating buildx builder: $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --use
else
  docker buildx use "$BUILDER"
fi
docker buildx inspect --bootstrap >/dev/null

if [[ "$NO_PUSH" == "1" ]]; then
  echo "▶ local build (single arch, no push) → ${IMAGE}:${VERSION}-local"
  docker buildx build \
    --load \
    --tag "${IMAGE}:${VERSION}-local" \
    .
  echo
  echo "✔ loaded ${IMAGE}:${VERSION}-local into local Docker"
  echo "  test:  docker run --rm -p 3001:3001 -v stock-manager-data:/data ${IMAGE}:${VERSION}-local"
  exit 0
fi

echo "▶ building & pushing ${IMAGE}:${VERSION} (and :latest) for ${PLATFORMS}"
docker buildx build \
  --platform "$PLATFORMS" \
  --tag "${IMAGE}:${VERSION}" \
  --tag "${IMAGE}:latest" \
  --push \
  .

echo
echo "✔ pushed:"
echo "    ${IMAGE}:${VERSION}"
echo "    ${IMAGE}:latest"
echo
echo "  pull:  docker pull ${IMAGE}:latest"
echo "  run :  docker run -d -p 3001:3001 -v stock-manager-data:/data --name stock-manager ${IMAGE}:latest"
