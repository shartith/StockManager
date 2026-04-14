# v4.11.0 수정 계획 — 4/14 알림 데이터 분석 근거

## Context

2026-04-14 데이터 (dataset 기준 464 신호) 점검 결과 체결률 0.65% (3건). 고신뢰도(85+) BUY 188건이 유실됨. 3가지 근본 원인을 도출.

## A. 신호 cooldown (Rule 20)

**증거**: stock_id=142에서 BUY 15회, 143은 13회 — 같은 종목 반복 LLM 호출.

**구현**: `tradingRules.ts`에 `SIGNAL_COOLDOWN` rule 추가. `continuousMonitor.ts`에서 LLM 호출 직전에 pre-check:
```ts
const recent = queryOne(
  "SELECT created_at FROM trade_signals WHERE stock_id = ? AND signal_type = ? AND created_at >= datetime('now', '-30 minutes') ORDER BY created_at DESC LIMIT 1",
  [stockId, 'BUY']
);
if (recent) continue; // skip LLM 호출
```

**설정**: `signalCooldownMinutes` (기본 30분, 0이면 비활성).

## B. 체결 실패 원인 system_event 기록

**증거**: 461건 체결 실패인데 system_events에 기록 없음.

**구현**:
- `kisOrder.executeOrder()` 실패 경로에 `logSystemEvent('WARN', 'TRADE_BLOCKED', reason, detail, ticker)` 추가
- `checkPositionSizingRules` 실패 → "포지션 한도 초과"
- `checkPromotionEligibility` 실패 → "승격 거절: 섹터 집중도 초과" 등
- KIS API error → "KIS API 오류: {code}"

**Dashboard 변경**: 이벤트 패널에 카테고리 "TRADE_BLOCKED" 추가.

## C. 연속 손실 종목 블랙리스트 (Rule 21)

**증거**: 18건 pair 중 stock_id=4, 31이 반복 등장. stock_id=31은 -20.9%, -9.7% 등 큰 손실.

**구현**: `tradingRules.ts`에 `RECENT_LOSS_PENALTY` rule:
```ts
// 최근 N건 trade_signals의 signal_performance를 보고 2건 이상 손실이면 confidence -30
const recentLosses = queryAll(...);
if (recentLosses.length >= 2) {
  totalConfidenceAdj -= 30;
  reasons.push(`최근 ${recentLosses.length}건 연속 손실 — 신뢰도 페널티`);
}
```

**설정**: `lossBlacklistLookback` (기본 5건), `lossBlacklistThreshold` (기본 2건).

## D. 체결률 대시보드 지표

**구현**: `Dashboard.vue`에 위젯 추가:
- 어제 신호 개수 / 체결 개수 / 체결률 %
- 이번 주 누적 체결률 추이

**API**: 신규 `GET /api/scheduler/fill-rate?days=7` 엔드포인트.

## 예상 공수

- A, B, D: ~200줄, 2시간
- C: ~100줄, 1시간
- 테스트: ~50줄, 30분

## 검증

- cooldown: trade_signals에 30분 내 BUY 2건이 없어야 함
- TRADE_BLOCKED: 이벤트 패널에 실패 사유 표시
- Anti-loss: stock_id=31 같은 반복 손실 종목은 confidence -30 → 더 이상 자동매수 안 됨
- 체결률 지표: 어제 날짜 기준 NN건 / MM건 / XX% 정상 계산
