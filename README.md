# Stock Manager

주식 포트폴리오 관리 및 자동매매 시스템.

KIS API 연동, Ollama LLM 매매 판단, 자동 스케줄링을 지원하는 웹 기반 트레이딩 플랫폼.

## 기능

- **포트폴리오 관리** — 보유 종목, 수익률, 자산배분 현황
- **차트** — KIS API 기반 캔들차트 (일/주/월봉)
- **기술적 분석** — RSI, MACD, Bollinger Bands, SMA/EMA
- **AI 매매 판단** — Ollama 로컬 LLM으로 매수/매도/홀드 결정
- **자동매매** — 스케줄러 기반 자동 매매 (KRX/NYSE/NASDAQ)
- **추천 종목** — 기술분석 + LLM 기반 종목 추천 및 스코어링
- **관심 종목** — 실시간 모니터링 및 자동매매 토글
- **성과 분석** — 신호 정확도, 가중치 최적화, 백테스트
- **뉴스 수집** — 네이버/Yahoo Finance 뉴스 + AI 요약

## 기술 스택

| 구분 | 기술 |
|------|------|
| Frontend | Vue 3, TypeScript, Tailwind CSS, Chart.js, Lightweight Charts |
| Backend | Express, TypeScript, sql.js |
| AI | Ollama (로컬 LLM), Claude/OpenAI API (뉴스 요약) |
| 주식 API | 한국투자증권 KIS API |
| 스케줄러 | node-cron (시장별 timezone 지원) |

## 설치

### Homebrew (Mac)

```bash
brew tap shartith/stockmanager
brew install stock-manager
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

## 데이터 저장 경로

| 모드 | 경로 |
|------|------|
| Homebrew 설치 | `~/.stock-manager/` |
| 직접 설치 (개발) | `프로젝트/data/` |

환경변수 `STOCK_MANAGER_DATA`로 커스텀 경로 지정 가능.

## 초기 설정

1. `stock-manager` 실행 후 브라우저에서 접속
2. **설정** 메뉴에서 KIS API 키 입력 (한국투자증권 개발자센터에서 발급)
3. (선택) Ollama 설치 및 모델 다운로드

### Ollama 설정 (Mac)

```bash
brew install ollama
ollama serve
```

설정 화면에서 모델 다운로드 가능. 권장 모델:
- `qwen3:4b` — 가벼운 범용 모델
- `llama3.1:8b` — 높은 정확도
- `gemma3:4b` — 빠른 응답

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

`package.json`의 version을 올린다:

```json
{
  "version": "1.1.0"
}
```

### 3. 빌드 확인

```bash
npm run build
```

에러 없이 완료되는지 확인.

### 4. 태그 생성 및 푸시

```bash
git tag v1.1.0
git push origin main --tags
```

### 5. GitHub Release 생성

```bash
# tarball 생성
git archive --format=tar.gz --prefix=stock-manager-1.1.0/ -o stock-manager-1.1.0.tar.gz v1.1.0

# GitHub CLI로 Release 생성 (gh 설치 필요: brew install gh)
gh release create v1.1.0 stock-manager-1.1.0.tar.gz --title "v1.1.0" --notes "변경 내용"
```

또는 GitHub 웹에서 Releases → Draft a new release → 태그 선택 → tarball 업로드.

### 6. Homebrew Formula 업데이트

```bash
# tarball SHA256 해시 계산
shasum -a 256 stock-manager-1.1.0.tar.gz

# homebrew-stockmanager 레포 클론
git clone https://github.com/shartith/homebrew-stockmanager.git
cd homebrew-stockmanager
```

`Formula/stock-manager.rb`에서 3곳 수정:

```ruby
url "https://github.com/shartith/StockManager/releases/download/v1.1.0/stock-manager-1.1.0.tar.gz"
sha256 "새로운_해시값"
version "1.1.0"
```

```bash
git add -A
git commit -m "Update to v1.1.0"
git push origin main
```

### 7. 사용자 업데이트

```bash
brew update
brew upgrade stock-manager
```

## 프로젝트 구조

```
StockManager/
├── bin/stock-manager          # CLI 엔트리포인트
├── client/                    # Vue 3 프론트엔드
│   └── src/
│       ├── views/             # 페이지 컴포넌트
│       ├── components/        # 공통 컴포넌트
│       ├── api/index.ts       # API 클라이언트
│       └── router/index.ts    # 라우터
├── server/                    # Express 백엔드
│   └── src/
│       ├── routes/            # API 라우트
│       ├── services/          # 비즈니스 로직
│       │   ├── scheduler.ts   # 자동매매 스케줄러
│       │   ├── ollama.ts      # LLM 연동
│       │   ├── kisOrder.ts    # KIS 주문 실행
│       │   └── technicalAnalysis.ts
│       └── db.ts              # 데이터베이스
├── data/                      # 로컬 데이터 (gitignore)
├── package.json
└── .gitattributes
```

## 라이선스

MIT
