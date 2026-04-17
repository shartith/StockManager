# Changelog

Stock Manager 주요 릴리즈 변경사항. 자세한 노트는 [GitHub Releases](https://github.com/shartith/StockManager/releases)에서 확인.

## v4.19.1 — 2026-04-17

**테스트 커버리지 3개 핵심 파일 85%+ 달성. 테스트 +71.**

- **weightOptimizer.ts**: 8.95% → **98.50%** (+89.55p). 20 테스트. 조기 종료 분기(샘플 부족/개별 타입 미충족), MIN/MAX 클램프, 양·음 상관에 따른 조정, loadWeights/saveWeights/resetWeights 전체 커버.
- **backtester.ts**: 59.45% → **97.97%** (+38.52p). 29 테스트. runBacktest 시뮬레이션 분기(60캔들 미만, 상승/평탄/하락 추세, weights override, maxPerTrade), runABCompare, saveBacktestResult, getLatestBacktest, isBacktestFresh, collectBacktestCandidates.
- **tradingRules.ts**: 74.27% → **98.54%** (+24.27p). 22 테스트. 기존 미커버였던 Rule 15~21: SECTOR_HEADWIND, BREADTH_DIVERGENCE, SECTOR_TAILWIND, NARROW_LEADERSHIP, POOR_QUOTE_QUALITY(+strictMode), SIGNAL_COOLDOWN, RECENT_LOSS_PENALTY 전체 분기.
- **전체**: 676 → **747 tests pass** (+71). services 전체 55.32% → 60.09%.

### 제외 영역 (통합 테스트 필요)
- routes/* (15 files): Express 핸들러, supertest 기반 통합 테스트 별도 세션
- scheduler/* (대부분): cron + 외부 API 의존, mock server 아키텍처 필요
- services/{calculator, dartApi, exchangeRate, exportImport, heatmapData, investorFlow, newsCollector, orderManager, sectorMomentum, websocket}: 외부 API/WebSocket 의존

## v4.19.0 — 2026-04-17

**USE_CASES 남은 gap 3건 보완 — 양방향 NAS sync MVP + weightOptimizer 텔레메트리 + 백테스트 유의성 임계값 설정 가능.**

- **양방향 NAS sync MVP** (UC-08 확장): `services/nasImport.ts` 신규. 다른 디바이스가 올린 jsonl을 내 DB로 import. **append-only 테이블 8종**만 지원 (transactions, auto_trades, trade_signals, system_events, audit_log, weekly_reports, backtest_results, weight_optimization_log). 상태 테이블(recommendations/watchlist/stocks)은 충돌 해결 미구현으로 제외. **id 컬럼 제외 INSERT**로 디바이스 간 PK 충돌 회피. `last_import.json`에 디바이스별 마지막 import 시점 저장하여 중복 방지. 자기 디바이스 폴더(`device-{hostname}`) 자동 제외. **opt-in**: `settings.nasImportEnabled=true` 필요 (기본 false). NAS sync cron 직후 자동 실행.
- **weightOptimizer 조기 종료 텔레메트리** (UC-10 보완): 샘플 부족/개별 타입 최소 미충족 시 `system_events`에 `WEIGHT_OPTIMIZER_SKIP` INFO 이벤트 기록. `totalSamples`·`perTypeCounts` 반환값 추가. signal_performance 축적 전까지 왜 최적화가 안 되는지 가시성 확보.
- **백테스트 유의성 임계값 설정 가능**: `settings.backtestMinTradesForSave` 신규 (optional, 기본 5). 기존 하드코딩 5거래 기준을 사용자 오버라이드 가능하게. 데이터 축적 시 30 등으로 상향 권장.
- **테스트 +13**: nasImport 13건 (opt-in 3 + import 5 + 중복방지 3 + 에러처리 2). 663 → **676 pass**.

### NAS import 설정 예시
\`\`\`json
{
  "nasSyncEnabled": true,
  "nasSyncPath": "/Volumes/stock-manager",
  "nasImportEnabled": true,
  "backtestMinTradesForSave": 5
}
\`\`\`

## v4.18.0 — 2026-04-17

**USE_CASES 구조 보완 3건: failure_reason 구조화 + LLM provider 자동 스위치 + weekendLearning smoke 테스트.**

- **`auto_trades.failure_reason` 구조화 컬럼**: 기존 `error_message` 문자열 LIKE 키워드 매칭 의존 제거. enum-like `FailureReason` (SUSPENDED/INSUFFICIENT_FUNDS/WIDE_SPREAD/LOW_LIQUIDITY/POSITION_LIMIT/QUOTE_FETCH_FAIL/PROTECTION_BLOCKED/NETWORK/API_ERROR/UNKNOWN) 도입. `classifyFailure()` 헬퍼로 KIS/일반 에러 메시지 자동 분류. DB 마이그레이션 idempotent ALTER. 기존 레코드는 backward compat (`failure_reason=''`이면 keyword matching fallback).
- **`isSuspendedToday` 구조화 우선**: 쿼리에 `failure_reason = 'SUSPENDED'` 체크 추가 (OR 결합), 새 레코드부터 구조화 필드 우선. 기존 키워드 매칭은 호환 유지.
- **LLM provider 자동 스위치** (UC-06 3단계 확장): primary URL retry 3회 전부 실패 → `llmFallbackUrl` 1회 시도 → 그마저 실패해야 기술적 분석 fallback. 예: ai.unids.kr 외부 → localhost:11434 로컬 Ollama. `settings.llmFallbackUrl/llmFallbackModel/llmFallbackApiKey` 신규 필드 (optional, undefined이면 기존 동작). primary URL과 동일하면 fallback skip.
- **weekendLearning 통합 smoke 테스트**: 외부 API(fetchCandleData) + LLM 호출 mock하여 전체 파이프라인 오케스트레이션 검증. 후보 종목 0개·캔들 부족·API 실패 각각의 resilience 확인.
- **테스트 +32건**: classifyFailure 17 + isSuspendedToday 구조화 3 + weekendLearning smoke 6 + llm-fallback 6. 631 → **663 pass**.

## v4.17.1 — 2026-04-17

**USE_CASES gap 보강: 테스트 51건 신규 + watchlistCleanup 버그 1건 fix.**

- **UC-07 테스트 (kisOrder isSuspendedToday)**: 함수를 `export`로 공개하고 `kisOrder-isSuspended.test.ts` 신규 15건. APBK0066/거래정지/매매정지/상장폐지/정리매매 키워드 매칭, 날짜 경계(자정 자동 해제), status 필터(FILLED/PENDING 제외), stock_id 격리, 최신 이력 선택 검증.
- **UC-12 테스트 (watchlistCleanup)**: `watchlistCleanup.test.ts` 신규 20건. 5가지 정리 규칙 + 4가지 만료 규칙 + 실보유 종목 보호 + BUY 신호 있음/없음 경계 검증. `expireStaleRecommendations`의 score<0, confidence<50, 5일+ 만료, 7일+ 물리삭제 모두 커버.
- **UC-12 버그 fix (v4.17.1)**: watchlistCleanup 규칙 3(저점수) 에서 추천이 없는 종목(`latestScore=null`)을 0점으로 간주해 삭제하던 문제. 수동 관심종목(추천 시스템 미사용)이 3일 후 전부 삭제되는 버그. `latestScore == null` 시 skip으로 수정.
- **UC-11 테스트 (scoring BACKTEST_*)**: `scoring-backtest.test.ts` 신규 16건. PF≥1.5 가점(+15), PF<1.0 감점(-20), 중립 구간(1.0~1.49), freshness/significance 가드, 예외 안전성 검증.
- **전체**: 580 → **631 tests pass** (+51).

## v4.17.0 — 2026-04-17

**백테스트 파이프라인 통합 — 실시간 결정이 아닌 "구조적 종목 필터"로 활용.**

- **주말 자동 백테스트 루프**: `weekendLearning.ts` 확장. 대상을 기존 "최근 체결 5종목"에서 **최근 체결 + 관심종목 + 활성 추천 상위** 최대 30종목으로 확대. 결과를 `backtest_results` DB에 저장 (거래 5건 이상 통계 유의성 확보 시). `collectBacktestCandidates()` 헬퍼 신규.
- **Protection `BacktestReject`** (4번째): 종목 최신 백테스트 `profit_factor < 0.8` 이면 매수 차단. 7일 이내 + 5거래 이상 조건(fresh + significant) 충족 시에만 발동. 백테스트 없거나 오래되면 판단 보류 (통과). "실시간 매수 결정"이 아닌 "전략이 이 종목에 통하지 않는다"는 구조적 필터.
- **스코어링 백테스트 반영** (신규 2종 ScoreType): `BACKTEST_PROFITABLE` (PF≥1.5 → +15), `BACKTEST_UNPROFITABLE` (PF<1.0 → -20). 점수 경쟁에 스며들어 순위 결정에 기여.
- **`getLatestBacktest()` / `isBacktestFresh()`** 조회 헬퍼 신규. 백테스트 결과의 신선도·통계 유의성 판정 일원화.
- **테스트**: `protections.test.ts` 신규 21건 (StoplossGuard 4, CooldownPeriod 4, LowProfitPairs 3, BacktestReject 7, config 2, override 1). 기존 scoring 테스트 1건 async 누락 수정. 총 580/580 pass.

## v4.16.0 — 2026-04-17

**freqtrade 영감 적용: Protection 시스템 + ROI Table.**

- **Protection 시스템**: 전략 수준 circuit breaker 3종 신규 추가 — `StoplossGuard`(최근 6h 내 손절 3건 초과 시 전체 BUY 차단), `CooldownPeriod`(종목 거래 후 30분 재진입 금지), `LowProfitPairs`(종목 최근 5거래 평균 수익률 < -5%면 해당 종목 BUY 차단). `executeOrder` 시작부에서 평가, 차단 시 `PROTECTION_BLOCKED` 이벤트 기록. 4/17 stock_id=289 SELL 28회 반복 같은 사건 재발 방지 + 전략 자체가 망가지는 상황 조기 감지.
- **ROI Table**: `sellRules`에 시간 경과별 목표 수익률 감쇠 테이블 도입. 형식 `[[minutes, profitPct], ...]` (예: `[[0, 3.0], [30, 2.0], [60, 1.0], [120, 0]]`). 기존 `targetProfitRate` 고정값 + `maxHoldMinutes` 단일 강매도의 이분법을 **시간축 risk-tiered exit**으로 대체. 미설정 시 기존 동작 유지 (후방 호환). 전략 프리셋 4종 모두 `roiTable` 포함으로 업데이트.
- **프리셋 ROI 테이블**: scalping `[0:3%, 20:2%, 40:1%, 60:0%]`, intraday `[0:5%, 60:3%, 180:1.5%, 360:0%]`, swing `[0:10%, 1d:8%, 2d:6%, 4d:4%, 7d:0%]`, position `[0:25%, 7d:20%, 14d:15%, 30d:10%]`.
- **테스트**: `sellRules.test.ts`에 ROI Table 8건 추가 (경계값, 시간 구간, 후방호환, STOP_LOSS 독립성 검증). 총 559/559 pass.
- **backtester 조사**: 기존 `backtester.ts`·`backtest_results` 테이블 존재 확인. 수동 실행 3건만 기록. 자동화·주기적 실행·weightOptimizer 연동은 후속 작업 예정.

## v4.15.0 — 2026-04-17

**장애 복원력 강화 + 스코어링 엔진 구조 개선. 애널리스트 관점 진단 반영.**

- **거래정지 종목 당일 차단**: `executeOrder` 시작부에 `isSuspendedToday()` 게이트 추가. 오늘 자 `auto_trades`에서 `APBK0066`/`거래정지`/`매매정지`/`상장폐지`/`정리매매` 키워드로 FAILED 이력이 있으면 즉시 차단. `TRADE_BLOCKED` 이벤트 기록. 자정 경과 시 자동 해제. 4/17 stock_id=289 SELL 28회 전부 실패 같은 무한 재시도 방지.
- **LLM fallback confidence 동적화**: 고정 50(BUY/SELL) → 기술 지표 합의 개수에 비례 (reasons 1~2: 45, 3~4: 60, 5+: 70). 기존 고정 50은 추천 등록 임계값 60을 절대 통과하지 못해 LLM 장애 시 추천이 사라지는 문제 해결.
- **전략 프리셋 4종 도입**: `scalping`(1h)/`intraday`(6h)/`swing`(1w)/`position`(1m). `TRADING_PRESETS` 상수 + `getPresetPatch()` 유틸. 기존 설정은 변경하지 않고 사용자가 선택 시 `targetProfitRate`/`hardStopLossRate`/`trailingStopRate`/`maxHoldMinutes`/`investmentStyle`을 일괄 적용 가능.
- **watchlistCleanup 조건 완화**: 규칙 1 (BUY 신호 없음) 3일→7일, 규칙 3·4·5 유예기간 1일→3일. 시장 약세·LLM 장애·휴장 구간에서 무고한 종목 대량 삭제 방지. 4/16 watchlist 25건 일괄 삭제 같은 사건 재발 차단.
- **승격 순위 모집단 가드**: ACTIVE 추천이 20개 미만이면 순위 조건(상위 5/10위)을 skip 하는 대신 **점수 임계값을 1.2× 상향** (auto 100→120, watchlist 80→96). 소모집단에서 경쟁 검증 없이 점수만으로 승격되는 것을 방지.
- **TIME_DECAY 양/음 대칭 감쇠**: 기존은 양수만 20% 감쇠 → SELL/HOLD 페널티가 영구 누적되어 한번 꺾인 종목은 회복 불가 (자기 확증 편향). 이제 음수도 같이 상쇄 — "누적 페널티 회복" 레이블로 기록.
- **baseScore (score_type × 날짜) 디듀플리케이션**: 기존은 7일치 전체 점수를 단순 합산 → 같은 MACD 골든크로스가 하루 4회 × 7일 = 28번 중복 가산. 이제 `(score_type, DATE(created_at))` 그룹당 최신 1건(`MAX(id)`)만 유효 → 점수가 "머무름의 함수"가 되는 것 방지.
- **스케줄러 기동 백필**: 서버 시작 5초 후 `backfillUntrackedSignals()` + `evaluatePendingPerformance()` 즉시 1회 실행. 18:00 KST 평일 1회 스케줄만 의존하던 기존 방식은 디바이스 간 이행·장기 오프라인 후 복귀 시 공백 발생.

## v4.14.0 — 2026-04-16

**시장별 TOP 50 경쟁 구도 도입. 적극적 감점 시스템.**

- **적극적 감점**: SELL 시그널 -20, 연속 SELL -25/회(max -75), HOLD -5, 연속 HOLD 3회+ 추가 -15, 낮은 신뢰도(<40%) -10, 하위 50% 순위 감쇠 -10. 6개 새 ScoreType 추가.
- **시장별 TOP 50**: 추천종목 슬롯을 시장당 10개 → 50개로 확대. 매 시간 순위 밖 종목 자동 퇴출 (`pruneBottomRanks`).
- **순위 기반 승격**: 기존 80점 무조건 승격 → 80점 이상 + 시장 내 상위 10위 이내일 때만 관심종목 승격. 자동매매는 100점 + 상위 5위.
- **경쟁 수명 확대**: 추천 만료 기간 3일 → 5일. 즉시 만료 기준 score<40 → score<0 으로 완화 (감점으로 음수 전환 시 퇴출).
- **SELL/HOLD 스코어링**: 기존에는 BUY 아닌 시그널을 즉시 EXPIRED 처리. 이제 스코어링 엔진을 통해 감점 적용 후 경쟁에서 자연 도태.
- **DB 마이그레이션**: `recommendations` 테이블에 `consecutive_holds`, `consecutive_sells` 컬럼 추가.
- **테스트 커버리지**: vitest config에 coverage 설정 추가. regression test `llmProvider` 누락 수정.

## v4.13.0 — 2026-04-15

**외부 OpenAI 호환 LLM 연결로 전환. MLX 번들 제거.**

- **LLM 전환**: 번들된 Apple MLX 서버 제거, 외부 OpenAI 호환 엔드포인트로 통합 (`ai.unids.kr`, Ollama, OpenAI 등 지원). 하드웨어/OS 제한 해제.
- **설정 필드 이름 변경**: `mlxUrl`/`mlxModel`/`mlxEnabled` → `llmUrl`/`llmModel`/`llmEnabled`. 신규 `llmApiKey` (Bearer 토큰) 필드 추가. 기본 `llmUrl`은 `https://ai.unids.kr/v1`. `llmModel` 기본값은 빈 값 (사용자 선택).
- **URL 규약**: `llmUrl` 은 `/v1` 을 포함한 full base URL (OpenAI 관례). 내부에서 `${llmUrl}/chat/completions`, `${llmUrl}/models` 형태로 호출.
- **자동 마이그레이션**: 기존 `mlxEnabled`/`mlxUrl`/`mlxModel` 값은 1회에 한해 `llm*` 으로 이관. 구 MLX 기본 URL(`http://localhost:8000`)은 새 기본값으로 대체, 사용자 커스텀 URL은 보존. 모델은 포맷 호환성 이유로 빈 값으로 리셋.
- **bin/stock-manager**: MLX 자동 설치/기동 코드 (`ensureMlx`, Python venv, mlx-lm pip install) 완전 제거. 잔존 venv는 `rm -rf ~/.stock-manager/venv` 로 수동 제거.
- **API**: `POST /api/analysis/llm/pull` / `DELETE /api/analysis/llm/models/:name` → 410 Gone (외부 LLM 사용 시 서버 측 관리 불필요).
- **NAS 동기화**: `llmApiKey` 는 SECRET_FIELDS 에 추가되어 외부 공유 시 마스킹. `llmUrl`/`llmModel`/`llmApiKey` 는 DEVICE_SPECIFIC_FIELDS 로 동기화에서 제외.
- **Settings UI**: MLX 섹션 → "외부 LLM 서버 (OpenAI 호환)" 로 개편. URL/API 키/모델 입력 필드 + 예시 힌트 제공.

## v4.12.2 — 2026-04-14

**Ollama 잔존 참조 일괄 정리 (cosmetic + e2e bug 수정)**

- **버그**: `e2e/new-features.spec.ts`가 health check에서 `checks.ollama` 속성 검증 → `checks.llm`으로 수정 (v4.12.0에서 실제로는 `checks.llm`을 emit하지만 테스트가 남아있었음)
- **DB source 태그**: 신규 `trade_signals` insert의 source 값 `'ollama-recommend'` → `'llm-recommend'`, `'ollama-auto'` → `'llm-auto'` (기존 DB row는 보존)
- **에러 메시지**: `'Ollama가 비활성화되어 있습니다'` → `'MLX LLM이 비활성화되어 있습니다'`
- **시스템 이벤트 카테고리**: 신규 `LLM_DOWN` 추가, 신규 emit은 `LLM_DOWN`로 전환. 기존 DB의 `OLLAMA_DOWN` row 조회/표시 호환을 위해 union에 legacy 항목 유지
- **주석/로그**: `llm.ts`, `newsCollector.ts`, `analysis.ts`, `feedback.ts`, `scheduler/*` 및 테스트 헤더 주석에서 Ollama 참조 → LLM/MLX로 정리
- **테스트 mock URL**: `http://localhost:11434` → `http://localhost:8000` (MLX 기본 포트와 일치)
- **Debian package**: `scripts/build-deb.sh` 패키지 설명문 갱신
- 테스트 547/547 통과

## v4.12.1 — 2026-04-14

**기본 MLX 모델 교체: gemma-3-4b-it-4bit → gemma-3n-E4B-it-4bit**

- 신규 기본 모델 `mlx-community/gemma-3n-E4B-it-4bit` (~4.4GB) — Gemma 3n 매트료시카 아키텍처
- 설정/스키마/bin 스크립트/문서/Homebrew caveats 일괄 갱신
- 기존 `gemma-3-4b-it-4bit` 사용자는 설정 유지 (기본값만 변경). 신규 설치 시에만 새 모델 다운로드

## v4.12.0 — 2026-04-14

**Ollama → MLX 완전 전환 (Apple Silicon 전용 LLM 백엔드)**

- 로컬 LLM 엔진 Ollama 제거, Apple MLX 기반 `mlx-lm` 서버로 교체
- 신규 `server/src/services/llm.ts` (ollama.ts 대체) — OpenAI-호환 `/v1/chat/completions` 어댑터, mutex/retry/timeout 유지
- 신규 엔드포인트: `/api/analysis/llm/{status,models,pull}`, `DELETE /api/analysis/llm/models/:name`
- 설정: `ollamaUrl/Model/Enabled` → `mlxUrl/Model/Enabled` (legacy 필드 자동 strip, `ollamaEnabled=true`이면 `mlxEnabled=true`로 자동 승계)
- 기본 설정: `http://localhost:8000`, `mlx-community/gemma-3n-E4B-it-4bit`, `mlxEnabled=true`
- Homebrew 통합: `bin/stock-manager`의 `ensureMlx()`가 `~/.stock-manager/venv` 생성 + `mlx-lm` 설치 + `mlx_lm.server` 기동을 자동 수행
- 신규 명령: `stock-manager --uninstall-ollama` — 바이너리 + `~/.ollama/` 모델 + brew 서비스 일괄 정리 (확인 프롬프트)
- Ollama 잔존 감지 → 시작 시 안내 메시지 출력 (`detectOllamaLeftovers`)
- UI: 설정 > "Ollama (로컬 LLM)" → "MLX (Apple Silicon 로컬 LLM)", 추천 모델 목록 교체 (gemma-3-4b-it / Qwen2.5-7B / Llama-3.2-3B / gemma-2-2b, 전부 4bit 양자화), `mlx_lm.server` 수동 실행 가이드 추가
- Dashboard `systemStatus.ollamaConnected` → `llmConnected`
- 헬스체크: `server/src/index.ts` → `/v1/models` 호출
- 테스트: 547/547 통과 (mock 포맷 OpenAI-호환으로 일괄 변환, 파일명 `llm*.test.ts`로 rename)
- 신규 문서: [`docs/MLX_MIGRATION.md`](docs/MLX_MIGRATION.md) — 기존 사용자용 마이그레이션 + 제거 가이드
- Intel Mac 제한: MLX가 Apple Silicon 전용이므로 Intel Mac에서는 LLM 기능 비활성화 (WARN 안내 후 계속 기동)

**Breaking changes**:
- 외부 연동 스크립트가 Ollama endpoint/response 포맷을 호출하던 경우 갱신 필요 (`/api/generate` → `/v1/chat/completions`, `data.response` → `data.choices[0].message.content`)

## v4.7.4 — 2026-04-08

**테스트 커버리지 확장 (소스 변경 없음)**

- 서버 커버리지 **58% → 86%** (stmts), **52% → 90%** (funcs)
- 테스트 **331 → 473건** (+142), 테스트 파일 15 → 23
- 신규 테스트: `kisAuth`, `quoteBook` 확장, `schemas`, `signalAnalyzer`, `stockPrice-extra`, `stockPrice-fundamentals`, `ollama-decision`, `ollama-status`, `systemEvent-aiAdvice`
- `kisAuth.ts` 100% / `quoteBook.ts` 98.75% / `schemas/index.ts` 97.05% 달성
- fetch 모킹 하네스 (`vi.stubGlobal`) + 모듈 격리 (`vi.resetModules`) + in-memory SQLite 기반
- E2E 추가: `bulk-delete.spec.ts` (v4.7.1-v4.7.3 API 검증)

## v4.7.3 — 2026-04-07

**보안/품질 리뷰 권고사항 일괄 적용**

- `deleteAllEvents`/`deleteAllNotifications`에 audit_log 영구 기록
- Dashboard 미해결 CRITICAL 이벤트 존재 시 "모두 삭제" 버튼 비활성화
- `DELETE /notifications/:id`, `PATCH /notifications/:id/read`에 `Number.isFinite` 검증 추가
- empty catch 제거 → 사용자 토스트로 실패 노출
- `notifications` ref 타입 `any[]` → `Notification[]`
- `Notification.is_read` 타입 `boolean` → `0 | 1` (SQLite 실제 저장 형식)

## v4.7.2 — 2026-04-06

**TDD가 발견한 production 버그 + 회귀 테스트**

- **Silent production bug 수정**: `resolveEvent` SQL의 `datetime("now")` → `datetime('now')` (v4.6.0 better-sqlite3 마이그레이션 이후 잠복)
- 시스템 이벤트/알림 CRUD + bulk delete에 대한 회귀 테스트 19건 추가

## v4.7.1 — 2026-04-05

**시스템 이벤트/알림 전체 삭제 기능**

- `DELETE /system-events/all` + `DELETE /system-events/all?resolved=true`
- `DELETE /notifications/all`
- Express 라우트 순서 주의: `/all`이 `/:id`보다 먼저 등록

## v4.7.0 — 2026-04-04

**외부 코드 리뷰 P1-P3 일괄 적용**

- ATR 기반 동적 임계값 (gap/volume surge/sideways 감지)
- EV (Expected Value) 모델 — KRX 왕복 수수료 0.40% 반영한 penalty
- axios 전역 에러 인터셉터 (empty catch 18개 → toast 알림)
- Vue `defineAsyncComponent` lazy loading 전환
- Vue `inject/provide`로 toast 싱글톤 공유

## v4.6.0 — 2026-04-03

**sql.js → better-sqlite3 완전 마이그레이션**

- 모든 execute()가 full DB export + sync writeFileSync 하던 v4.5.3까지의 병목 해결
- WAL 모드 + `synchronous=NORMAL` + statement cache (`Map<string, Database.Statement>`)
- `STOCK_MANAGER_DB_PATH=:memory:` 지원 → 테스트 격리 가능해짐
- 100% backward-compat API (`queryAll/queryOne/execute` 시그니처 유지)
- v4.5.x 전체 개선 사항에 대한 TDD 회귀 테스트 28건 추가

## v4.5.3 — 2026-04-02

**포트폴리오/KIS 조회 속도 10-30x 개선**

- 보유 종목만 쿼리 (HAVING SUM > 0 서브쿼리)
- 순차 KIS 호출 → `Promise.all` 병렬 + `maxConcurrent` 3
- N+1 trade_signals 조회 → INNER JOIN + GROUP BY
- 60초 가격 캐시 (`priceCache`)

## v4.5.2 — 2026-04-01

**Ollama 안정성 대규모 개선 (OLLAMA_DOWN 285+ 이벤트/일 해결)**

- `AbortController` 기반 120초 timeout (Fix #1)
- 모듈 레벨 promise chain mutex — 동시 호출 직렬화 (Fix #2)
- 3회 재시도 + 지수 백오프 — `fetch failed`/`ECONNREFUSED`/`ECONNRESET` 등 (Fix #3)
- `keep_alive: '15m'` — 모델 메모리 상주 (Fix #4)
- 업데이트 후 서버 재시작 버그 수정 (detached spawn + unref)
- 설정 저장 버그 수정 — ENV_SECRETS 스냅샷으로 두번째 저장 시 키 증발 방지
- 외부 AI (Claude/OpenAI) 설정 제거 — 로컬 Ollama 전용 명시

## v4.5.1 — 2026-03-30

**포트폴리오 KIS 계좌 양방향 reconcile**

- added/adjusted/removed/unchanged 매트릭스 기반 통합 reconcile
- 보유 수량/평단가 불일치 자동 교정

## v4.5.0 — 2026-03-28

**UI/UX 현대화 + 백엔드 기능 확장**

- Vue 3 디자인 시스템 전면 개편 (CSS Custom Properties 기반 토큰)
- 주기적 자동 리로드 기능
- 한국/미국 시장 히트맵 (D3 treemap)
- 섹터 로테이션 분석 + 시장 breadth → AI 입력 컨텍스트
- KIS 10단계 호가 기반 품질 분석 (Rule 19: `POOR_QUOTE_QUALITY`)
- 포트폴리오 설정 (max holdings, sector concentration, min cash)

---

v4.4.x 이하는 [GitHub Releases](https://github.com/shartith/StockManager/releases) 참고.
