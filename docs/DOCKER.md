# Docker 배포 가이드

Stock Manager는 도커 이미지로 배포됩니다. 이미지는 Docker Hub의
[`shartith0106/stock-manager`](https://hub.docker.com/r/shartith0106/stock-manager)
에서 받을 수 있고, **linux/amd64**와 **linux/arm64**(Apple Silicon)를 모두 지원합니다.

기본값은 모두 이미지에 박혀 있어 `docker run` 한 줄로 바로 동작합니다.

| 항목 | 기본값 |
|------|--------|
| 포트 | `3001` |
| 데이터 경로 | `/data` (DB · settings.json) — 볼륨 필수 |
| 타임존 | `Asia/Seoul` |
| 사용자 | non-root (`app`) |
| Healthcheck | `wget --spider /` 30초 간격 |

---

## 1. Docker Desktop GUI에서 실행

1. Docker Desktop → **Images** → **Search** → `shartith0106/stock-manager` 검색 → **Pull**
2. 받은 이미지 옆 **Run** 버튼 클릭 → **Optional settings** 펼치기
3. 다음 값을 입력하고 **Run**:
   - **Container name**: `stock-manager`
   - **Host port**: `3001`
   - **Volumes** → Host path 또는 named volume `stock-manager-data` → Container path `/data`
4. 브라우저에서 <http://localhost:3001> 접속

> Container path `/data`만 마운트하면 DB와 KIS API 키 설정이 영구 보존됩니다.

---

## 2. CLI 한 줄 실행

```bash
docker run -d \
  --name stock-manager \
  -p 3001:3001 \
  -v stock-manager-data:/data \
  --restart unless-stopped \
  shartith0106/stock-manager:latest
```

확인:
```bash
docker ps                  # 상태
docker logs -f stock-manager
open http://localhost:3001
```

업데이트:
```bash
docker pull shartith0106/stock-manager:latest
docker rm -f stock-manager
# 위 run 명령 다시 실행 — 볼륨이 그대로라 데이터 유지됨
```

---

## 3. docker compose

저장소 루트에 `docker-compose.yml`이 들어 있습니다.

```bash
docker compose up -d        # 시작
docker compose logs -f      # 로그
docker compose pull         # 최신 이미지로 업데이트
docker compose up -d        # 재기동 (볼륨 유지)
docker compose down         # 중지 (볼륨 보존)
```

---

## 4. 첫 실행 후 설정

KIS API 키, LLM URL 같은 민감 정보는 **이미지에 굽지 않습니다**. 컨테이너 기동 후
브라우저로 접속해 **설정** 화면에서 입력하세요. 입력값은 `/data/settings.json` 및
`/data/stock-manager.db`에 저장되고, 마운트한 볼륨에 그대로 남습니다.

---

## 5. 이미지 빌드 & 푸시 (개발자용)

멀티아키 빌드는 `docker buildx` 가 필요합니다 (Docker Desktop에 기본 포함).

```bash
docker login                              # Docker Hub 로그인 (1회)

# 멀티아키(amd64+arm64) 빌드 후 Hub로 푸시 — 버전 태그는 package.json 에서 자동 추출
./scripts/build-docker.sh

# 명시적 버전 지정
./scripts/build-docker.sh 5.2.1

# 로컬에서만 동작 확인 (푸시 안 함, 현재 머신 아키만)
./scripts/build-docker.sh --no-push
```

스크립트가 다음을 자동 처리합니다:
- `stock-manager-builder` 이름의 buildx 빌더 생성/재사용
- `linux/amd64,linux/arm64` 두 아키 동시 빌드
- `:VERSION` + `:latest` 두 태그 푸시

---

## 6. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|------|
| 컨테이너가 곧바로 종료 | `docker logs stock-manager` 확인 — 대개 포트 충돌 또는 볼륨 권한 문제 |
| `EACCES /data/...` | 볼륨 권한 문제. named volume(`-v stock-manager-data:/data`)을 쓰면 자동 해결 |
| KRX 장 시간 어긋남 | 호스트 타임존과 무관하게 컨테이너는 KST로 고정. 그래도 이상하면 `docker exec stock-manager date` 로 확인 |
| Apple Silicon에서 amd64 강제 실행 | `docker run --platform linux/amd64 ...` (Rosetta 필요, 느림) |
| 멀티아키 빌드 실패 | `docker buildx inspect stock-manager-builder --bootstrap` 로 빌더 초기화 후 재시도 |

---

## 7. 보안 메모

- 이미지에는 **민감 정보가 없습니다** (API 키 / 토큰은 모두 `/data` 볼륨에서 읽음).
- 컨테이너는 non-root(`app`) 사용자로 실행됩니다.
- 외부 노출 시 리버스 프록시(Nginx/Caddy/Traefik)에서 TLS 종단을 처리하세요.
