# Stock Manager

주식 포트폴리오 관리 및 자동매매 시스템.

KIS API 연동, MLX 기반 로컬 LLM 매매 판단, 자동 스케줄링을 지원하는 웹 기반 트레이딩 플랫폼 (Apple Silicon 전용).

## 기능

- **포트폴리오 관리** — 보유 종목, 수익률, 자산배분 현황, KIS 계좌 양방향 reconcile
- **가상매매 시스템** — 실제 자산 투입 전 가상 포트폴리오로 AI 매매 전략 검증
- **차트** — KIS API 기반 캔들차트 (일/주/월봉)
- **기술적 분석** — RSI, MACD, Bollinger Bands, SMA/EMA, ATR 기반 동적 임계값
- **AI 매매 판단** — MLX 기반 로컬 LLM(Apple Silicon)으로 매수/매도/홀드 결정 (단일 모드 + debate 모드)
- **자동매매** — 스케줄러 기반 자동 매매 (KRX/NYSE/NASDAQ) 및 즉각적인 수동 실행 지원
- **매매 원칙 엔진** — 19가지 룰 기반 신호 검증 (다양한 매도 규칙, 포지션 사이징, 섹터 집중도, EV 모델 등)
- **추천 종목 및 스크리닝** — 동적 스크리닝 엔진을 활용한 기술분석 + LLM 기반 종목 발굴 및 추천
- **관심 종목** — 실시간 모니터링 및 자동매매 토글
- **히트맵** — 한국/미국 시장 섹터 로테이션 + 시장 breadth 분석
- **호가 품질 분석** — KIS 10단계 호가 기반 스프레드/깊이/슬리피지 판정 (GOOD/FAIR/POOR)
- **성과 분석** — 신호 정확도, Pearson 상관 가중치 최적화, 백테스트
- **뉴스 수집** — 네이버/Yahoo Finance 뉴스 + AI 요약
- **시스템 이벤트 & 알림** — 운영 이벤트 로깅 + LLM 조언 append + bulk delete + audit log
- **NAS 자동 동기화** — 외부 백업 (API 키 마스킹) + 로컬 백업 (API 키 포함) 분리 + 페이지네이션 공통 지원

## 기술 스택

| 구분 | 기술 |
|------|------|
| Frontend | Vue 3, TypeScript, Vite, Tailwind CSS, Chart.js, Lightweight Charts, D3 (히트맵) |
| Backend | Express, TypeScript, better-sqlite3 (WAL 모드, statement cache) |
| AI | MLX (Apple Silicon 로컬 LLM, mlx-lm + OpenAI-호환 서버) — 외부 API 키 사용 안 함 |
| 주식 API | 한국투자증권 KIS API |
| 스케줄러 | node-cron (시장별 timezone 지원) |
| 테스트 | Vitest (서버), Playwright (E2E) |

## 설치

### Homebrew (Mac)

```bash
brew tap shartith/stockmanager
brew install stock-manager
```

### APT (Ubuntu/Debian)

```bash
echo "deb [trusted=yes] https://shartith.github.io/apt-stockmanager stable main" | sudo tee /etc/apt/sources.list.d/stock-manager.list
sudo apt update
sudo apt install stock-manager
```

### 직접 설치

```bash
git clone https://github.com/shartith/StockManager.git
cd StockManager
npm install
npm run build
npm start
```

## 실행

### 프로덕션 모드

```bash
# Homebrew로 설치한 경우
stock-manager

# 직접 설치한 경우
npm start
```

`http://localhost:3000`에서 접속.

### 개발 모드

```bash
npm run dev
```

- Frontend: `http://localhost:5173` (HMR)
- Backend: `http://localhost:3001` (자동 재시작)

## 개발 및 테스트

### 서버 유닛 테스트 (Vitest)

```bash
cd server
npm test                # 전체 실행
npm test -- --coverage  # 커버리지 리포트
```

**서버 품질 상태 (테스트 커버리지 측정은 v4.7.4 기준 / 현재 최신버전 v4.10.1)**:

| 항목 | 수치 |
|------|------|
| 테스트 파일 | 23개 |
| 테스트 | 473건 |
| Stmts 커버리지 | 85.68% |
| Funcs 커버리지 | 89.62% |
| Lines 커버리지 | 87.88% |

모든 테스트는 in-memory SQLite (`STOCK_MANAGER_DB_PATH=:memory:`) + `vi.stubGlobal('fetch', …)` 목으로 **네트워크 의존 없이** 실행된다.

### E2E 테스트 (Playwright)

```bash
npx playwright test     # 전체 E2E
```

`e2e/` 디렉토리에 API CRUD, 헬스체크, bulk delete 검증 등이 있다.

### 기타 품질 검증

```bash
# 서버 타입 체크
cd server && npx tsc --noEmit

# 클라이언트 타입 체크
cd client && npx vue-tsc --noEmit

# 프로덕션 빌드
npm run build
```

## 데이터 저장 경로

| 모드 | 경로 |
|------|------|
| Homebrew 설치 | `~/.stock-manager/` |
| 직접 설치 (개발) | `프로젝트/data/` |

환경변수 `STOCK_MANAGER_DATA`로 커스텀 경로 지정 가능.

## 초기 설정

1. `stock-manager` 실행 후 브라우저에서 접속
2. **설정** 메뉴에서 KIS API 키 입력 (한국투자증권 개발자센터에서 발급)
3. MLX 서버는 Homebrew 설치 시 자동 구성 (수동 실행은 아래 참고)

### MLX 설정 (Apple Silicon Mac)

Homebrew로 `stock-manager`를 설치하면 mlx-lm + 기본 모델이 함께 설치됩니다. 최초 실행 시 모델(`mlx-community/gemma-3n-E4B-it-4bit`, ~4.4GB)이 자동 다운로드됩니다.

개발 모드에서 수동 기동:

```bash
python3 -m venv ~/.stock-manager/venv
~/.stock-manager/venv/bin/pip install mlx-lm
~/.stock-manager/venv/bin/mlx_lm.server --port 8000 --model mlx-community/gemma-3n-E4B-it-4bit
```

설정 화면에서 모델 변경 가능. 권장 모델:
- `mlx-community/gemma-3n-E4B-it-4bit` — 기본, ~4.4GB, Gemma 3n 매트료시카 아키텍처, 한국어 양호
- `mlx-community/Qwen2.5-7B-Instruct-4bit` — 4GB, 16GB+ RAM 권장
- `mlx-community/Llama-3.2-3B-Instruct-4bit` — 1.8GB, 빠른 응답
- `mlx-community/gemma-2-2b-it-4bit` — 1.3GB, 저사양

> **Intel Mac 주의**: MLX는 Apple Silicon 전용입니다. Intel Mac에서는 LLM 기능이 비활성화됩니다.
> 기존 Ollama 사용자는 `stock-manager --uninstall-ollama`로 정리 가능. 자세한 내용은 [docs/MLX_MIGRATION.md](docs/MLX_MIGRATION.md) 참고.

## Homebrew 배포 가이드

다른 컴퓨터에서 코드를 수정하고 Homebrew에 새 버전을 배포하는 절차.

### 1. 코드 수정 및 커밋

```bash
git clone https://github.com/shartith/StockManager.git
cd StockManager
npm install

# 코드 수정 후
git add -A
git commit -m "변경 내용 설명"
```

### 2. 버전 업데이트

루트 / `server/` / `client/` 세 곳의 `package.json` version을 올린다:

```json
{
  "version": "4.10.2"
}
```

### 3. 빌드 확인

```bash
npm run build
```

에러 없이 완료되는지 확인.

### 4. 태그 생성 및 푸시

```bash
git tag v4.10.2
git push origin main --tags
```

### 5. GitHub Release 생성

```bash
# tarball 생성
git archive --format=tar.gz --prefix=stock-manager-4.10.2/ -o /tmp/stock-manager-4.10.2.tar.gz v4.10.2

# GitHub CLI로 Release 생성 (gh 설치 필요: brew install gh)
gh release create v4.10.2 /tmp/stock-manager-4.10.2.tar.gz --title "v4.10.2" --notes "변경 내용"
```

또는 GitHub 웹에서 Releases → Draft a new release → 태그 선택 → tarball 업로드.

### 6. Homebrew Formula 업데이트

```bash
# tarball SHA256 해시 계산
shasum -a 256 /tmp/stock-manager-4.7.5.tar.gz

# homebrew-stockmanager 레포 클론
git clone https://github.com/shartith/homebrew-stockmanager.git
cd homebrew-stockmanager
```

`Formula/stock-manager.rb`에서 4곳 수정 (url, sha256, version, caveats):

```ruby
url "https://github.com/shartith/StockManager/releases/download/v4.10.2/stock-manager-4.10.2.tar.gz"
sha256 "새로운_해시값"
version "4.10.2"
# ...
#   Stock Manager v4.10.2
```

```bash
git add -A
git commit -m "Update to v4.10.2"
git push origin main
```

### 7. 사용자 업데이트

```bash
brew update
brew upgrade stock-manager
```

## APT 배포 가이드 (Linux)

### 1. .deb 패키지 빌드 & APT 저장소 업데이트

```bash
# .deb 빌드 + APT 저장소 갱신 (한 번에)
bash scripts/update-apt.sh
```

### 2. 사용자 설치

```bash
echo "deb [trusted=yes] https://shartith.github.io/apt-stockmanager stable main" | sudo tee /etc/apt/sources.list.d/stock-manager.list
sudo apt update
sudo apt install stock-manager
```

### 3. 사용자 업데이트

```bash
sudo apt update
sudo apt upgrade stock-manager
```

## 프로젝트 구조

```
StockManager/
├── bin/stock-manager          # CLI 엔트리포인트
├── client/                    # Vue 3 프론트엔드
│   └── src/
│       ├── views/             # 페이지 컴포넌트
│       ├── components/        # 공통 컴포넌트
│       ├── api/index.ts       # API 클라이언트 (axios + 전역 에러 인터셉터)
│       ├── types/             # 공유 타입 정의
│       └── router/index.ts    # 라우터
├── server/                    # Express 백엔드
│   └── src/
│       ├── routes/            # API 라우트
│       ├── schemas/           # zod 입력 검증 스키마 (SSRF 가드 포함)
│       ├── services/          # 비즈니스 로직
│       │   ├── scheduler/     # 자동매매 스케줄러 + 헬퍼
│       │   ├── llm.ts         # MLX LLM 연동 (mutex + retry + timeout, OpenAI-호환 API)
│       │   ├── kisAuth.ts     # KIS OAuth 토큰 관리
│       │   ├── kisOrder.ts    # KIS 주문 실행
│       │   ├── quoteBook.ts   # 호가 품질 분석
│       │   ├── tradingRules.ts     # 19가지 매매 원칙 엔진
│       │   ├── technicalAnalysis.ts
│       │   ├── signalAnalyzer.ts   # 신호 정확도/상관 분석
│       │   ├── portfolioReconcile.ts # KIS 계좌 양방향 reconcile
│       │   ├── heatmap.ts     # 섹터/시장 히트맵
│       │   ├── systemEvent.ts # 시스템 이벤트 로깅 + AI 조언
│       │   └── notification.ts
│       ├── __tests__/         # Vitest 유닛 테스트 (473건, 85.68% 커버리지)
│       └── db.ts              # better-sqlite3 + WAL + statement cache
├── e2e/                       # Playwright E2E 테스트
├── data/                      # 로컬 데이터 (gitignore)
├── package.json
└── .gitattributes
```

## 변경 이력

주요 릴리즈별 변경사항은 [CHANGELOG.md](./CHANGELOG.md)에서 확인할 수 있다. 자세한 릴리즈 노트는 [GitHub Releases](https://github.com/shartith/StockManager/releases)에 있다.

## 라이선스

MIT
