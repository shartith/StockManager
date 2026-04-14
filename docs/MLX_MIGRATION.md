# Ollama → MLX 전환 가이드 (v4.12.0)

Stock Manager v4.12.0부터 로컬 LLM 백엔드가 **Ollama에서 MLX**로 전환되었습니다.
이 문서는 기존 Ollama 사용자를 위한 마이그레이션 안내입니다.

## 요약

| 구분 | v4.11 이하 (Ollama) | v4.12.0+ (MLX) |
|------|---------------------|----------------|
| 엔진 | Ollama (Go binary) | mlx-lm (Python, Apple MLX) |
| 포트 | 11434 | 8000 |
| API | `/api/generate` (Ollama 고유) | `/v1/chat/completions` (OpenAI-호환) |
| 기본 모델 | `qwen3:4b` | `mlx-community/gemma-3-4b-it-4bit` |
| 플랫폼 | 모든 플랫폼 | **Apple Silicon 전용** |
| 설치 경로 | `/opt/homebrew/bin/ollama` | `~/.stock-manager/venv/bin/mlx_lm.server` |
| 모델 캐시 | `~/.ollama/models` | `~/.cache/huggingface/hub` |

## 왜 MLX로?

- **속도**: Apple Silicon에 최적화된 unified memory 활용 → 토큰 생성속도 향상
- **메모리 효율**: 동일 모델 대비 RAM 사용량 감소
- **HuggingFace 생태계 직접 접근**: mlx-community 양자화 모델 다수

## 자동 전환

1. `brew upgrade stock-manager` (또는 신규 설치)
2. 최초 실행 시 Python venv + mlx-lm + 기본 모델이 자동 설치됨 (최대 5분)
3. 설정에 저장된 `ollama*` 필드는 자동으로 legacy 처리되어 제거되며, `mlxEnabled`가 true로 전환됨

## 기존 Ollama 제거 (권장)

v4.12.0부터 Ollama는 사용되지 않습니다. 디스크 공간 확보를 위해 제거를 권장합니다.

### 자동 (권장)

```bash
stock-manager --uninstall-ollama
```

이 명령은 다음을 수행합니다:
- 실행 중인 `ollama` 프로세스 종료
- `brew services stop ollama` + `brew uninstall ollama`
- `~/.ollama/` 디렉토리 삭제 (다운로드된 모델 전부 — 수 GB)

> **주의**: 위 명령은 되돌릴 수 없습니다. 제거 전 반드시 확인을 요구합니다.

### 수동

```bash
brew services stop ollama 2>/dev/null
brew uninstall ollama 2>/dev/null
rm -rf ~/.ollama          # 모델 전부 제거 (수 GB)
```

### 부분 제거 (모델만)

다른 도구에서 Ollama를 계속 쓴다면 바이너리는 남기고 모델만 정리:

```bash
ollama list                # 설치된 모델 확인
ollama rm qwen3:4b         # 개별 제거
rm -rf ~/.ollama/models    # 모든 모델 일괄 제거
```

## 트러블슈팅

### MLX 서버가 시작되지 않는다

로그 확인:

```bash
tail -100 ~/.stock-manager/mlx.log
```

흔한 원인:
1. **Apple Silicon이 아님**: `uname -m`이 `arm64`가 아니면 MLX 불가. Intel Mac은 LLM 없이 동작
2. **Python 3이 없음**: `brew install python@3.12` 후 재시도
3. **venv 손상**: `rm -rf ~/.stock-manager/venv` 후 `stock-manager` 재실행

### 모델 다운로드가 느리다

최초 다운로드는 HuggingFace에서 ~2.5GB를 가져옵니다. 네트워크에 따라 2~5분 소요.
캐시 위치: `~/.cache/huggingface/hub/models--mlx-community--gemma-3-4b-it-4bit`

### 다른 모델로 변경하고 싶다

1. 웹 UI → **설정** → **MLX (Apple Silicon 로컬 LLM)** 섹션
2. 추천 모델 버튼 클릭 또는 직접 입력 (HuggingFace repo명, 예: `mlx-community/Qwen2.5-7B-Instruct-4bit`)
3. **다운로드** 클릭 → 자동 캐시
4. 사용 모델 셀렉터에서 선택 후 **저장**

### 기존 Ollama API 호출 코드가 있다

코드베이스에서 `services/ollama` → `services/llm`, `/analysis/ollama/*` → `/analysis/llm/*`로 전면 교체되었습니다.
외부 연동 스크립트가 있다면 endpoint와 response 포맷(Ollama `response` 필드 → OpenAI `choices[0].message.content`)을 갱신하세요.

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `MLX_PORT` | `8000` | MLX 서버 포트 |
| `MLX_MODEL` | `mlx-community/gemma-3-4b-it-4bit` | 기본 모델 |
| `STOCK_MANAGER_VENV` | `$STOCK_MANAGER_DATA/venv` | Python venv 경로 (Homebrew는 `libexec/venv` 주입) |

## 참고 자료

- MLX: https://github.com/ml-explore/mlx
- mlx-lm: https://github.com/ml-explore/mlx-lm
- mlx-community 모델: https://huggingface.co/mlx-community
