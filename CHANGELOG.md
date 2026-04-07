# Changelog

Stock Manager 주요 릴리즈 변경사항. 자세한 노트는 [GitHub Releases](https://github.com/shartith/StockManager/releases)에서 확인.

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
