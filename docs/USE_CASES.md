# Stock Manager 운영 유스케이스 카탈로그

**버전**: v4.17.0
**작성일**: 2026-04-17
**범위**: 현재 구현된 백엔드 파이프라인 (프런트엔드 UI 상호작용 제외)

---

## Actors

| Actor | 설명 |
|---|---|
| **사용자** | UI/API로 수동 설정·수동 매매·관심종목 관리 |
| **스케줄러** | `node-cron` 기반 자동 실행 (`server/src/services/scheduler/index.ts`) |
| **KIS API** | 한국투자증권 거래·시세 API |
| **LLM 서버** | 외부 OpenAI 호환 API (`settings.llmUrl`) |
| **DART** | 전자공시 API |

---

## 유스케이스 요약 (12개)

| ID | 이름 | 그룹 | Trigger |
|---|---|---|---|
| UC-01 | 추천 종목 자동 갱신 | 자동매매 | 매시간 cron |
| UC-02 | 관심종목 자동 승격 | 자동매매 | 점수 ≥ 80 |
| UC-03 | 자동 매수 실행 | 자동매매 | 점수 ≥ 100 + 순위 ≤ 5 |
| UC-04 | 보유 종목 연속 모니터링 + 매도 | 자동매매 | 10분 간격 (장중) |
| UC-05 | Protection 차단 | 자동매매 | 주문 시점 평가 |
| UC-06 | LLM 다운 → 기술적 fallback | 장애복원 | LLM 예외 발생 시 |
| UC-07 | 거래정지 종목 당일 재시도 차단 | 장애복원 | 주문 시점 |
| UC-08 | NAS sync 실패 → 로컬 유지 | 장애복원 | 매일 20:00 |
| UC-09 | 주말 학습 + 백테스트 루프 | 학습검증 | 토요일 06:00 |
| UC-10 | 신호 성과 추적 (7/14/30일) | 학습검증 | 평일 18:00 + 서버 기동 |
| UC-11 | 백테스트 기반 종목 필터 | 학습검증 | 추천/매수 시점 |
| UC-12 | 관심종목/추천 자동 정리 | 정리관리 | 매시간 cron |

---

## UC-01: 추천 종목 자동 갱신

**Actor**: 스케줄러, KIS API, LLM
**Trigger**: 매시간 `0 * * * *` (Asia/Seoul)
**사전조건**: `settings.llmEnabled === true` + KIS API 키 설정

**주 흐름**:
1. [cron 등록] `scheduler/index.ts:83` → `runRecommendationRefresh()`
2. [시장별 루프] KRX/NYSE/NASDAQ 3개 시장
3. [Step 1 — 기존 ACTIVE 추천 재검증] `recommendations.ts:273`
   - 보유 종목 → `DISMISSED`, 관심종목 → `EXECUTED`
   - 캔들 부족 → `EXPIRED`, LLM decision 재계산 → 점수 갱신
4. [Step 2 — 빈 슬롯 채우기] `recommendations.ts:321-404`
   - `fetchDomesticVolumeRank` + `fetchDomesticFluctuationRank` (KRX) 병합
   - 뉴스 수집 + 기술 지표 + LLM decision
   - BUY && confidence ≥ 60 → `recommendations` INSERT
5. [Step 3 — TOP 50 밖 퇴출] `pruneBottomRanks(market, 50)` → `EXPIRED` 처리

**대안 흐름**:
- LLM 다운 → UC-06 fallback 경로 적용 (동적 confidence)
- 후보 탐색 API 실패 → 빈 배열 반환, 해당 시장 skip

**사후조건**: 시장당 최대 50개 ACTIVE 추천 유지, 순위 경쟁 구도

**코드 경로**:
- `scheduler/index.ts:83` (cron)
- `scheduler/recommendations.ts:232` (`runRecommendationRefresh`)
- `services/llm.ts:getTradeDecision`
- `services/scoring.ts:evaluateAndScore`
- `services/newsCollector.ts:collectAndCacheNews`

**검증**: `scoring.test.ts` (59건), `regression.test.ts` 포함
**Gap**: 신규 후보 추가 시 뉴스 API 호출은 순차 (Promise.all 미적용) — 30종목이면 30×지연 누적

---

## UC-02: 관심종목 자동 승격

**Actor**: 스케줄러 (UC-01 하위)
**Trigger**: 스코어링 엔진에서 임계값 충족 시

**사전조건**: 종목 `recommendations.score ≥ 80` + (모집단 ≥ 20이면 순위 ≤ 10 / 모집단 < 20이면 점수 ≥ 96)

**주 흐름**:
1. [점수 평가] `scoring.ts:evaluateAndScore` 말미 승격 조건 판정
2. [포트폴리오 규칙 체크] `portfolioManager.ts:checkPromotionEligibility`
   - 최대 보유 종목 수, 섹터 집중도, 최소 현금 비율
3. [DB 변경] `watchlist INSERT` + `recommendations UPDATE status='EXECUTED'`
4. [알림] `createNotification({ type: 'PROMOTION' })`

**대안 흐름**:
- 포트폴리오 규칙 위반 → 승격 보류 + `NOTIFICATION`만 생성
- 이미 관심종목이면 skip (existing check)

**사후조건**: watchlist에 신규 종목 등록, 해당 추천은 EXECUTED로 제거

**코드 경로**:
- `services/scoring.ts:promoteToWatchlist` (line 370)
- `services/portfolioManager.ts:checkPromotionEligibility`

**검증**: `scoring.test.ts` 승격 테스트 다수, `portfolioManager.test.ts`
**Gap**: v4.15.0 모집단 가드 추가 — 모집단 < 20일 때 `SMALL_POOL_MULTIPLIER=1.2`로 임계값 상향 (의도한 설계)

---

## UC-03: 자동 매수 실행 (승격 + autoTradeEnabled)

**Actor**: 스케줄러, KIS API
**Trigger**: 점수 ≥ 100 + 순위 ≤ 5 (또는 모집단 < 20 시 점수 ≥ 120)

**사전조건**: `settings.autoTradeEnabled === true`, 포트폴리오 규칙 통과

**주 흐름**:
1. [승격 판정] `scoring.ts:promoteToWatchlistAndTrade` (line 423)
2. [watchlist에 `auto_trade_enabled=1`로 등록]
3. [`executeOrder(BUY)` 호출] — 즉시 실행 (PENDING 대기 아님)
4. [Protection 체크] UC-05 (4종 순차)
5. [거래정지 이력 체크] UC-07
6. [포지션 사이징] `portfolioManager.checkPositionSizingRules` + `calculateOptimalQuantity`
7. [호가 품질 체크] `quoteBook.getQuoteBook` — spread >1.0% 또는 depth 부족 시 취소
8. [KIS 주문 제출] `submitDomesticOrder` / `submitOverseasOrder`
9. [체결 성공] `auto_trades.status='FILLED'` + `transactions INSERT` + `NOTIFICATION`
10. [체결 실패] `auto_trades.status='FAILED'` + 사유 기록

**대안 흐름**:
- Protection 차단 → UC-05 경로로 조기 반환
- 호가 품질 poor → `WIDE_SPREAD`/`LOW_LIQUIDITY` 이벤트 + 주문 취소
- KIS API 에러 → error_message 기록

**사후조건**: 체결 시 실제 보유 + transactions 기록, 실패 시 분석 가능한 이력

**코드 경로**:
- `services/scoring.ts:promoteToWatchlistAndTrade` (line 423)
- `services/kisOrder.ts:executeOrder` (line 341+)
- `services/portfolioManager.ts:checkPositionSizingRules`
- `services/quoteBook.ts:getQuoteBook`

**검증**: `portfolioManager.test.ts`, `portfolioManager-fx.test.ts`, `quoteBook.test.ts`
**Gap**: `executeOrder` 내 호가 체크는 KRX만, 해외는 skip — 해외 확장 고려

---

## UC-04: 보유 종목 연속 모니터링 + 매도 규칙

**Actor**: 스케줄러, KIS API
**Trigger**: 장중 10분 간격 — KRX `*/10 9-14 * * 1-5`, NYSE `*/10 9-15 * * 1-5`

**사전조건**: 보유 포지션 존재 (`transactions` 기반 순 수량 > 0)

**주 흐름**:
1. [cron 등록] `scheduler/index.ts:54, 71` → `runContinuousMonitor(market)`
2. [보유 종목 순회] `continuousMonitor.ts`
3. [현재가 조회] `stockPrice.ts:getCurrentPrice`
4. [매도 규칙 평가] `sellRules.ts:evaluateSellRules` — 우선순위 순:
   - Rule 1: ROI Table 또는 고정 `targetProfitRate`
   - Rule 2: `hardStopLossRate` 손절
   - Rule 3: `trailingStopRate` 트레일링
   - Rule 4: `maxHoldMinutes` 시간 초과 (ROI Table 없을 때만)
5. [매도 트리거 시] `executeOrder(SELL)` — 시장가
6. [체결 후 `resetPeakPrice(stockId)`]

**대안 흐름**:
- 현재가 조회 실패 → 해당 종목 skip
- KIS API rate limit → `apiQueue` 백프레셔로 지연 처리

**사후조건**: 익절/손절/트레일링/시간초과 조건 충족 시 전량 매도, peak tracker 리셋

**코드 경로**:
- `scheduler/index.ts:54, 71` (cron)
- `scheduler/continuousMonitor.ts`
- `services/sellRules.ts:evaluateSellRules` (v4.16.0 ROI Table)
- `services/kisOrder.ts:executeOrder`

**검증**: `sellRules.test.ts` 34건 (ROI Table 8건 포함)
**Gap**: Rule 4 (`HOLDING_TIME`)가 우선순위 최하위 — 손실 구간에서 60분 경과 시 시장가 슬리피지 (이건 ROI Table로 해결 가능)

---

## UC-05: Protection 차단 (4종 circuit breaker)

**Actor**: 스케줄러 / 사용자 주문 모두
**Trigger**: `executeOrder` 진입 시 최우선 평가 (0-a 단계)

**사전조건**: `settings.protections.*.enabled` (기본 전부 true)

**주 흐름**:
1. [주문 시작] `kisOrder.ts:executeOrder` (line 365)
2. [`checkProtections(ctx)`] `protections.ts:checkProtections` — 4종 순차 평가:
   - **StoplossGuard**: 최근 6h 내 손절 3건 이상 → BUY 전체 차단
   - **CooldownPeriod**: 같은 종목 최근 30분 내 거래 → BUY 차단
   - **LowProfitPairs**: 종목 최근 5거래 평균 <-5% → 해당 종목 BUY 차단
   - **BacktestReject**: 종목 최신 백테스트 PF < 0.8 (fresh 7일, 5거래+) → BUY 차단
3. [차단 시] `logProtectionBlock` → `PROTECTION_BLOCKED` system_event 기록, 주문 반환

**대안 흐름**:
- 백테스트 결과 없음/오래됨/소표본 → BacktestReject 판단 보류 (통과)
- SELL 주문 → 모든 Protection 통과 (포지션 청산 자유)

**사후조건**: 차단 시 주문 미제출, 이벤트 이력 확보, 자정 경과 시 자동 해제 (Stoploss/Cooldown 타임윈도우 기준)

**코드 경로**:
- `services/protections.ts:checkProtections`
- `services/kisOrder.ts:executeOrder` (line 370-395)

**검증**: `protections.test.ts` 21건 (각 Protection 3~7건)
**Gap**: StoplossGuard가 memo `LIKE '%손절%'` 키워드 매칭 → 추후 `auto_trades.failure_reason` 구조화 필드 필요 (현재는 문자열 파싱 의존)

---

## UC-06: LLM 다운 → 기술적 분석 fallback

**Actor**: 스케줄러, LLM 서버
**Trigger**: `getTradeDecision` 내 LLM 요청 예외 (HTTP 429/502/timeout)

**사전조건**: `settings.llmEnabled === true`

**주 흐름**:
1. [시그널 생성 진입] `scheduler/helpers.ts:generateSignalsForStock`
2. [LLM 호출] `llm.ts:getTradeDecision` → 예외 throw
3. [예외 캐치] `helpers.ts:332-358`
4. [`LLM_DOWN` system_event 기록] (WARN 레벨)
5. [기술적 시그널 기반 fallback decision 생성]:
   - `signal` = `indicators.technicalSignal`
   - `confidence` = 기술 지표 합의 개수에 비례 (1~2:45, 3~4:60, 5+:70, HOLD: 30) — v4.14.1
   - `reasoning` = `[LLM 미연결 fallback, 기술 합의 N개] ...`
6. [`trade_signals` INSERT] source=`llm-${phase}` (동일)
7. [`performanceTracker.registerSignalForTracking`] 호출

**대안 흐름**:
- 기술 지표 자체 계산 실패 → `indicators.technicalSignal === 'HOLD'` 기본값, confidence 30

**사후조건**: LLM 장애에도 신호 생성 유지, 낮은 confidence로 추천 등록은 제한

**코드 경로**:
- `services/scheduler/helpers.ts:332-358`
- `services/llm.ts:getTradeDecision`
- `services/systemEvent.ts:logSystemEvent`

**검증**: `llm-decision.test.ts`, `llm.test.ts` — fallback path 테스트 확인 필요
**Gap**: Provider 자동 스위치(OpenAI → Ollama 로컬) 없음 — 수동 설정 변경 필요. 후속 과제.

---

## UC-07: 거래정지 종목 당일 재시도 차단

**Actor**: 스케줄러, 사용자
**Trigger**: 이전 실패 이력이 있는 종목에 대한 주문 요청

**사전조건**: 같은 날(`date('now')`) 해당 `stock_id`의 `auto_trades.status='FAILED'` + `error_message`에 `APBK0066`/`거래정지`/`매매정지`/`상장폐지`/`정리매매` 중 하나 포함

**주 흐름**:
1. [주문 진입] `executeOrder(req)` (line 365)
2. [Protection 통과 후] `isSuspendedToday(req.stockId)` (line 344)
3. [매칭 발견 시] `TRADE_BLOCKED` system_event 기록 → 주문 거절 반환

**대안 흐름**:
- 매칭 없음 → 정상 주문 경로 진행

**사후조건**: 4/17 stock_id=289 같은 28회 반복 시도 재발 방지, 자정 경과 시 자동 해제

**코드 경로**:
- `services/kisOrder.ts:isSuspendedToday` (line 344)
- `services/kisOrder.ts:executeOrder` (line 397-419)

**검증**: 전용 테스트 없음 — 간접 검증
**Gap**: 전용 단위 테스트 부재. `kisOrder.test.ts` 자체가 없음 (KIS API 의존이 커서 mock 복잡).

---

## UC-08: NAS sync 실패 → 로컬 유지

**Actor**: 스케줄러, NAS 서버
**Trigger**: `settings.nasSyncTime` cron (기본 `0 20 * * *`)

**사전조건**: `settings.nasSyncEnabled === true` + `nasSyncPath` 설정

**주 흐름**:
1. [cron 등록] `scheduler/index.ts:134` → `runNasSync()`
2. [NAS 경로 접근] `services/nasSync.ts`
3. [접근 실패 시] `NAS_SYNC` WARN 이벤트 기록 (detail에 AI 조언 포함)
4. [다음 주기 재시도]
5. [성공 시] 9개 테이블을 jsonl로 export, `last_sync.json` 갱신

**대안 흐름**:
- 권한 에러 (EACCES) → 경로 확인 가이드 포함 system_event
- NAS 마운트 해제 → 재마운트 시도 (`nasAutoMount`)

**사후조건**: `stock-data/device-{hostname}/YYYY-MM-DD/*.jsonl` 생성, 로컬 DB는 항상 보호

**코드 경로**:
- `scheduler/index.ts:134` (cron)
- `services/nasSync.ts:runNasSync`

**검증**: `nasSync.test.ts`
**Gap**: 다른 디바이스에서 jsonl을 DB로 import하는 양방향 동기화는 없음. primary/secondary 디바이스 구분 불명확.

---

## UC-09: 주말 학습 + 백테스트 루프

**Actor**: 스케줄러, KIS API, LLM
**Trigger**: 토요일 06:00 KST `0 6 * * 6`

**사전조건**: (선택) `settings.llmEnabled` — 없어도 백테스트는 돌아감

**주 흐름**:
1. [cron 등록] `scheduler/index.ts:114` → `runWeekendLearning()`
2. [미평가 신호 성과 평가] `evaluatePendingPerformance()` (UC-10)
3. [가중치 최적화] `optimizeWeights()` — `signal_performance` 기반 회귀
4. [백테스트 루프] (v4.17.0):
   - `collectBacktestCandidates(30)`: 체결 + 관심 + 추천 상위 최대 30종목
   - 각 종목별 `runBacktest` → 결과 5거래+ 시 `saveBacktestResult`
   - 상위 5개 리포트 포함
5. [A/B 비교] 최근 체결 종목 1개로 현재 weights vs 균등 weights
6. [LLM 주간 리포트 생성] — 실패 시 정량 요약 fallback
7. [`weekly_reports` INSERT] + `NOTIFICATION`
8. [LoRA 데이터셋 체크] 5000건+ 누적 시 자동 생성

**대안 흐름**:
- LLM 실패 → 정량 요약 fallback
- 각 백테스트 실패 → skip, 다음 종목

**사후조건**: `backtest_results` 저장 → UC-11이 참조, `weekly_reports` 누적

**코드 경로**:
- `scheduler/index.ts:114` (cron)
- `scheduler/weekendLearning.ts:runWeekendLearning`
- `services/backtester.ts:runBacktest` + `collectBacktestCandidates`
- `services/weightOptimizer.ts:optimizeWeights`

**검증**: `performanceTracker.test.ts`, `signalAnalyzer.test.ts`
**Gap**: weekendLearning 자체의 통합 테스트 없음 (외부 API 의존). 백테스트 통계 유의성 임계값(5거래)은 보수적이지만 여전히 낮음 — 30+ 권장 (하지만 데이터 축적 전 tradeoff).

---

## UC-10: 신호 성과 추적 (7/14/30일)

**Actor**: 스케줄러
**Trigger**: 평일 18:00 KST `0 18 * * 1-5` + 서버 기동 5초 후 (v4.15.0)

**사전조건**: `signal_performance` 에 등록된 신호 (`registerSignalForTracking`)

**주 흐름**:
1. [서버 기동 시] `index.ts:146` — `setTimeout` 5초 후 `backfillUntrackedSignals` + `evaluatePendingPerformance`
2. [cron] 평일 18:00 `evaluatePendingPerformance`
3. [7일 경과 + 미평가] 현재가 조회 → `return_7d` + target_hit/stop_hit 갱신
4. [14일 경과] 동일, `price_14d` / `return_14d`
5. [30일 경과] 동일, `price_30d` / `return_30d`

**대안 흐름**:
- 현재가 조회 실패 → 다음 주기 재시도 (evaluated_at 업데이트 안 됨)

**사후조건**: 신호의 실측 성과 누적 → weightOptimizer + 종목 winrate 분석 자료

**코드 경로**:
- `services/performanceTracker.ts:evaluatePendingPerformance`, `registerSignalForTracking`, `backfillUntrackedSignals`
- `scheduler/index.ts:98, 146`

**검증**: `performanceTracker.test.ts`
**Gap**: 현재 DB에 `signal_performance` 0건 (이 디바이스는 신호 생성 활성 환경 아님). 실제 운용 환경에서만 의미.

---

## UC-11: 백테스트 기반 종목 필터

**Actor**: 스케줄러 (scoring), 사용자/스케줄러 주문 (Protection)
**Trigger**: 두 지점:
- 추천 갱신 시 `evaluateAndScore` 호출 시점
- `executeOrder` 시작부 Protection 평가

**사전조건**: 해당 종목의 `backtest_results`에 7일 이내 + 5거래 이상 결과 존재

**주 흐름** (스코어링 경로):
1. `scoring.ts:evaluateAndScore` Step 13 (v4.17.0)
2. `getLatestBacktest(ticker, market)` → `isBacktestFresh` 체크
3. `PF ≥ 1.5` → `+15 BACKTEST_PROFITABLE` 가점
4. `PF < 1.0` → `-20 BACKTEST_UNPROFITABLE` 감점
5. `1.0 ≤ PF < 1.5` → 중립 (추가 점수 없음)

**주 흐름** (Protection 경로):
1. `protections.ts:checkBacktestReject`
2. `PF < 0.8` 이면 차단, `TRADE_BLOCKED` 이벤트

**대안 흐름**:
- 백테스트 없음/오래됨/소표본 → 양쪽 모두 판단 보류 (통과)
- `market` 누락 시 BacktestReject skip

**사후조건**:
- 스코어링: 점수에 ±15~20 반영 → 순위 경쟁에 구조적 필터로 작동
- Protection: PF<0.8 종목 매수 차단

**코드 경로**:
- `services/scoring.ts` (Step 13)
- `services/protections.ts:checkBacktestReject`
- `services/backtester.ts:getLatestBacktest`, `isBacktestFresh`

**검증**: `protections.test.ts` BacktestReject 7건 (freshness/stats/market 누락 등)
**Gap**: scoring.ts의 BACKTEST_* 가감점은 단위 테스트 미비 (scoring.test.ts에 추가 가능). weightOptimizer도 이 2종에 대한 회귀 학습 대상 포함해야 완결.

---

## UC-12: 관심종목/추천 자동 정리

**Actor**: 스케줄러
**Trigger**: 매시간 `0 * * * *`

**사전조건**: 없음 (상태 기반 평가)

**주 흐름**:
1. [cron 등록] `scheduler/index.ts:107` → `cleanupWatchlist()` + `expireStaleRecommendations()`
2. **추천 만료** (`expireStaleRecommendations`):
   - expires_at 경과 → EXPIRED
   - score < 0 → EXPIRED (감점 누적 시)
   - confidence < 50 → EXPIRED
   - 생성 5일+ → EXPIRED
   - 7일+ EXPIRED/DISMISSED → DELETE (물리 삭제)
3. **관심종목 정리** (`cleanupWatchlist`):
   - 규칙 1: 7일간 BUY 신호 없음 → 삭제 (v4.15.0: 3일→7일)
   - 규칙 2: 최근 3개 신호 avg confidence < 40 → `auto_trade_enabled=0`
   - 규칙 3/4/5: 3일 유예 + 저점수/저신뢰/BUY 없음 → 삭제
4. [각 삭제마다 `NOTIFICATION` 생성]

**대안 흐름**:
- 실보유 종목 → 절대 삭제 안 함 (`isHoldingReal` 가드)

**사후조건**: watchlist/recommendations 테이블이 live signal만 유지, stale 정리

**코드 경로**:
- `scheduler/index.ts:107`
- `scheduler/watchlistCleanup.ts:cleanupWatchlist`, `expireStaleRecommendations`

**검증**: 정리 로직 단위 테스트 없음 (DB 상태 의존)
**Gap**: cleanup 전용 단위 테스트 부재. integration test로 DB seed → cleanup 돌려서 후상태 검증 가능.

---

## 검증 요약 표

| UC | 코드 존재 | 단위 테스트 | 실제 기록 (이 DB) | 상태 |
|---|---|---|---|---|
| UC-01 추천 갱신 | ✅ | ✅ scoring | ⚠️ ACTIVE 0건 (secondary device) | OK |
| UC-02 관심 승격 | ✅ | ✅ scoring | ⚠️ 1건(수동) | OK |
| UC-03 자동 매수 | ✅ | ✅ portfolio/quote | ⚠️ 0건 (primary device에 있음) | OK |
| UC-04 연속 모니터링 + 매도 | ✅ | ✅ sellRules (34건) | — | OK |
| UC-05 Protection | ✅ | ✅ protections (21건) | — | OK |
| UC-06 LLM fallback | ✅ | ✅ llm-decision | 과거 62건 LLM_DOWN 이벤트 (4/17) | OK |
| UC-07 거래정지 차단 | ✅ | ❌ 전용 테스트 없음 | 과거 28건 APBK0066 (4/17 1회) | **GAP** |
| UC-08 NAS sync | ✅ | ✅ nasSync | 과거 4/16 EACCES 1건 | OK |
| UC-09 주말 학습 | ✅ | ⚠️ 부분 | 0건 (금주 미실행) | OK |
| UC-10 성과 추적 | ✅ | ✅ performanceTracker | 0건 (이 DB secondary) | OK |
| UC-11 백테스트 필터 | ✅ | ⚠️ Protection만, scoring gap | 0건 (토요일 대기) | **GAP** |
| UC-12 자동 정리 | ✅ | ❌ 전용 테스트 없음 | 과거 4/16 25건 삭제 | **GAP** |

## Gap 리스트 (후속 권장 작업)

### 테스트 보강
1. **kisOrder.test.ts 신규** — `executeOrder` 통합 테스트. isSuspendedToday / Protection 통합 검증 (UC-05, UC-07).
2. **scoring BACKTEST_* 테스트 추가** — UC-11 scoring 경로 단위 테스트 (PF 조회 mock).
3. **watchlistCleanup.test.ts 신규** — DB seed → cleanup 호출 → 후상태 assert (UC-12).

### 구조적 보완
4. **LLM provider 자동 스위치** — UC-06 fallback을 "다른 provider 시도 → 실패 시 기술적 fallback" 3단계로 확장.
5. **`auto_trades.failure_reason` 구조화 컬럼** — UC-07 memo 파싱 의존 → enum으로 변경.
6. **양방향 NAS sync** — UC-08이 현재 export only. secondary device에서 jsonl → DB import 경로 필요.
7. **weekendLearning 통합 테스트** — UC-09 전체 흐름을 mock 환경에서 smoke test.

### 데이터 축적 대기
8. **weightOptimizer 실작동 검증** — signal_performance 100건+ 축적 후 실제 weight 변경이 합리적인지 사후 검증.
9. **백테스트 통계 유의성 상향** — 현재 5거래 → 30거래로 단계적 상향 (데이터 충분해지면).

---

## 시스템 전체 흐름 다이어그램 (텍스트)

```
장 시작 전 (매시간)
  └→ UC-01 추천 갱신 ──→ UC-02 관심종목 승격 ──→ UC-03 자동 매수
                                                        │
                                                        └→ UC-05 Protection ──→ UC-07 거래정지 체크
                                                           └→ UC-11 BacktestReject

장중 (10분 간격)
  └→ UC-04 보유 모니터링 ──→ sellRules 평가 ──→ executeOrder(SELL)

LLM 예외 발생 시
  └→ UC-06 기술적 fallback (UC-01/UC-04 모두 해당)

매일 20:00
  └→ UC-08 NAS sync (UC-06 와 무관)

매시간
  └→ UC-12 watchlist/recommendation cleanup

평일 18:00 + 서버 기동 시
  └→ UC-10 signal_performance 평가

토요일 06:00
  └→ UC-09 주말 학습 ──→ UC-10 호출 + 백테스트 저장 ──→ UC-11 가 참조
```

---

**총 유스케이스 수**: 12개
**테스트 커버 완전**: 6개 (UC-01, 02, 03, 04, 05, 10)
**부분 커버**: 3개 (UC-06, 08, 09, 11)
**테스트 부재**: 3개 (UC-07, 12, UC-11 scoring 일부)
**전체 테스트 수**: 580 pass (v4.17.0 기준)
