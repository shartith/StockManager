# 페이지별 기능 감사 리포트

**작성일**: 2026-04-14 (v4.8.1 기준)
**범위**: client/src/views/*.vue 전체 11개 뷰 + 백엔드 엔드포인트 매핑

---

## 🚨 CRITICAL — 즉시 수정 필요

### Settings.vue — v4.8.0 신규 설정 11개 UI에 전혀 노출 안 됨

백엔드 `saveConfigSchema`와 `AppSettings`에는 정의되어 있고, v4.8.0에서 엔진도 정상 동작하지만 **사용자가 값을 조정할 방법이 없다**. 기본값으로 동작하는 중.

| 그룹 | 누락 필드 | 기본값 | 영향 |
|---|---|---|---|
| **매도 규칙** | `sellRulesEnabled` | true | 끌 방법 없음 |
| | `targetProfitRate` | 3% | 조정 불가 |
| | `hardStopLossRate` | 2% | 조정 불가 |
| | `trailingStopRate` | 1.5% | 조정 불가 |
| | `maxHoldMinutes` | 60분 | 조정 불가 |
| **포지션 사이징** | `positionMaxRatio` | 25% | 조정 불가 |
| | `positionMinCashRatio` | 20% | 조정 불가 |
| | `positionMaxPositions` | 3종목 | 조정 불가 |
| **동적 스크리닝** | `dynamicScreeningEnabled` | true | 끌 방법 없음 |
| | `screeningVolumeRatioMin` | 1.5배 | 조정 불가 |
| | `screeningMinMarketCap` | 500억 | 조정 불가 |

**원인**: `/api/chart/config/form` 응답에 이 필드들이 포함되지 않고, Settings.vue 폼에도 섹션이 없음. schema만 있고 서버↔클라이언트 왕복 경로가 단절됨.

**수정 규모**: `chart.ts getConfigForm` 확장 + Settings.vue에 3개 섹션 추가 (~200줄).

---

## 🟡 HIGH — 기능 공백 (API는 있는데 UI에서 안 씀)

### 1. Dashboard.vue / Portfolio.vue

**portfolio/history 차트 완전 누락** — `portfolioApi.getHistory()` API는 정의됐지만 어디서도 호출 안 함. **자산 변화 추이 시각화가 없다.** 포트폴리오 뷰 전체에서 시계열 차트 부재.

**호가 품질 (quoteBook) 미노출** — `chartApi.getQuoteBook()` 있지만 어떤 뷰에서도 미사용. 매매 실행 전 GOOD/FAIR/POOR 판정이 LLM 입력에는 들어가지만 **사용자에게는 보이지 않음**.

### 2. Dashboard.vue

**Ollama 상태 표시만 있고 토글 없음** (Line 211-215). 연결 끊긴 상태에서 원클릭 재연결/재시작 불가.

**보유 종목 액션 버튼 부재**. Portfolio.vue엔 매수/매도/차트/분석 버튼 있는데 Dashboard에는 없음. 대시보드에서 바로 조치 불가.

**시장 Breadth / 섹터 rotation 표시 없음** — Heatmap.vue에만 존재. 매매 판단에 중요한 지표인데 대시보드 첫 화면에서 안 보임.

### 3. Heatmap.vue

**`GET /rotation` 엔드포인트 미사용** (Line 없음) — 백엔드에서 섹터별 rotation 신호(IN/OUT/NEUTRAL) 계산까지 다 해주는데 UI에서 호출 안 함.

**Breadth 경고 없음** — `narrowLeadership`, `divergenceWarning` 필드가 백엔드 응답에 있지만 렌더링 안 함. 과열/발산 신호 미표시.

### 4. ChartView.vue

**보조 지표 토글 없음** — lightweight-charts 라이브러리를 쓰면서 RSI/MACD/볼린저밴드 오버레이가 없다. 차트 백엔드 데이터는 가능하지만 UI 미구현.

**신호 마커 없음** — 어느 날짜에 BUY/SELL 신호가 발생했는지 차트 위에 점/삼각형으로 표시 안 됨. `trade_signals` 테이블의 created_at을 차트에 overlay하면 되는데 미구현.

**실제 매매 시점 미표시** — 사용자가 실제 매수/매도한 시점 (`transactions.date`, `auto_trades.created_at`)을 차트에 표시하지 않음.

**시장 컨텍스트 배너 없음** — KOSPI/VIX/환율 정보는 Dashboard에만 있고 Chart 뷰에는 없음.

### 5. Feedback.vue

**백테스트 입력 폼 없음** — `POST /feedback/backtest` 엔드포인트가 완성됐지만 UI에선 **이미 실행된 결과 리스트만 조회 가능**. 새 백테스트를 돌려볼 수 없음.

**가중치 상관계수 시각화 없음** — `getScoreTypeCorrelations()` 같은 분석이 백엔드에 있지만 UI에서 호출 안 함.

---

## 🟠 MEDIUM — CRUD 공백 (공통 패턴)

**거의 모든 데이터 뷰에 편집(edit) UI가 없다** — 생성/삭제만 가능하고 수정은 "삭제 후 재생성". 특히:

| 뷰 | 누락 | 비고 |
|---|---|---|
| **Watchlist** | 메모 인라인 편집 | `PATCH /:id` 엔드포인트 있음. 현재가/등락률 표시 부재 |
| **Transactions** | 거래 수정, 세금/수수료 분리 필드, CSV/KIS import | 대량 import가 없으면 초기 데이터 입력 노동 집약적 |
| **Dividends** | 배당률 계산, 연간 캘린더, ex-dividend 알림, 종목별 누적 | 현재는 단순 합계만 |
| **Alerts** | 조건 수정, 트리거 히스토리, AND/OR 복합 조건 | 몇 번 울렸는지 안 보임 |
| **Recommendations** | LLM 재분석 버튼, 카테고리 필터, 점수 정렬, 원클릭 "watchlist + auto_trade" 승격 | `GET /categories` 완전 미사용 |

**페이지네이션 전역 부재** — 모든 뷰가 전체 데이터 한 번에 로드. 100건+ 시 성능 문제 예상.

**Bulk actions 부재** — 다중 선택 체크박스 + 일괄 삭제/비활성화 기능 전무 (단, 시스템 이벤트/알림은 "모두 삭제" 있음).

**유효성 에러 상세 메시지 없음** — zod 검증 실패 시 대부분 catch 블록이 비어있거나 일반 에러만 표시. 어떤 필드가 왜 틀렸는지 알려주지 않음.

---

## 🟢 LOW — 품질/UX 개선 여지

**로딩 skeleton 부재** — 대부분 "로딩 중..." 텍스트만. `LoadingSkeleton.vue` 컴포넌트가 있는데 일부에서만 사용.

**empty state 미흡** — "데이터가 없습니다" 수준. 가이드/다음 액션 제안 없음.

**정렬 UI 없음** — 어느 뷰도 테이블 헤더 클릭 정렬 미지원.

**검색 기능 제한적** — 대부분 단순 필터 탭. 종목명/티커 실시간 검색 없음 (ChartView만 예외).

---

## 📊 요약 통계

| 뷰 | 기능 완성도 | 미노출 API | 핵심 공백 |
|---|---|---|---|
| Dashboard | 85% | portfolio/history, quoteBook | 히스토리 차트, 호가 품질 |
| Portfolio | 80% | portfolio/history, quoteBook | 히스토리 차트 |
| **Settings** | **~65%** | **11개 신규 필드** | **v4.8.0 규칙 전부** |
| ChartView | 55% | market-context, quote-book, signals | 지표 토글, 신호 마커 |
| Heatmap | 60% | rotation | 섹터 rotation 뷰 |
| Feedback | 90% | — | 백테스트 입력 폼 |
| Recommendations | 70% | categories | LLM 재분석, 승격 원클릭 |
| Watchlist | 65% | — | 메모 편집, 현재가 |
| Transactions | 70% | — | 편집, CSV import |
| Dividends | 60% | — | 배당률 계산, 캘린더 |
| Alerts | 55% | — | 편집, 히스토리 |

---

## 🎯 권장 수정 순서

1. **[CRITICAL] Settings.vue — v4.8.0 신규 설정 11개 노출** (~200줄)
   - 매도 규칙 / 포지션 사이징 / 동적 스크리닝 3개 섹션
   - `chart.ts getConfigForm` 응답 확장
   - 기존 `TradingRulesSection`, `portfolioMax*` 섹션과 같은 패턴

2. **[HIGH] Dashboard + Portfolio 히스토리 차트** (~150줄)
   - `portfolioApi.getHistory()` 호출
   - Chart.js line chart로 자산 curve 렌더

3. **[HIGH] ChartView 보조 지표 + 신호 마커** (~300줄)
   - lightweight-charts의 Indicator API 또는 별도 pane
   - trade_signals.created_at을 마커로 overlay

4. **[HIGH] Heatmap rotation 뷰 탭 추가** (~80줄)
   - `heatmapApi.getRotation()` 호출
   - 섹터별 momentum 막대 + IN/OUT 화살표

5. **[MEDIUM] Feedback 백테스트 입력 폼** (~120줄)
   - 종목 선택 + 기간 + initialCapital → POST /backtest

6. **[MEDIUM] CRUD 편집 기능 공통 도입** (~50줄/뷰)
   - Watchlist/Transactions/Dividends/Alerts/Recommendations에 edit modal

7. **[LOW] 페이지네이션 공통 컴포넌트** (~100줄)
   - Transactions가 가장 급함 (100건+ 가능성 높음)

---

**총 예상 공수**: 1~3 (CRITICAL + HIGH)만 해도 실제 사용성 큰 폭 개선. 1번은 자동매매 안전성에 직결되어 가장 시급.
