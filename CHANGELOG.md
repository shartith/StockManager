# Changelog

Stock Manager 주요 릴리즈 변경사항. 자세한 노트는 [GitHub Releases](https://github.com/shartith/StockManager/releases)에서 확인.

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
