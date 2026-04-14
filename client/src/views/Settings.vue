<template>
  <div class="max-w-2xl">
    <h2 class="text-2xl font-bold text-txt-primary mb-2">설정</h2>
    <p class="text-txt-secondary text-sm mb-8">한국투자증권 API 연동 및 앱 설정을 관리합니다.</p>

    <!-- 현재 상태 배지 -->
    <div class="flex items-center gap-2 mb-6">
      <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium"
        :class="configStatus.configured ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'">
        <span class="w-1.5 h-1.5 rounded-full" :class="configStatus.configured ? 'bg-green-500' : 'bg-red-500'"></span>
        {{ configStatus.configured ? 'API 연결됨' : 'API 미설정' }}
      </span>
      <span v-if="configStatus.configured" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium"
        :class="configStatus.isVirtual ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'">
        {{ configStatus.isVirtual ? '모의투자 계좌' : '실계좌' }}
      </span>
    </div>

    <form @submit.prevent="saveConfig" class="space-y-6">

      <!-- 섹션 1: API 인증 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">API 인증 정보</h3>
          <p class="text-xs text-txt-secondary mt-0.5">
            <a href="https://apiportal.koreainvestment.com" target="_blank" class="text-accent hover:underline">KIS Developers 포털</a>에서 앱을 등록하고 발급받은 키를 입력하세요.
          </p>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">
              App Key <span class="text-red-500">*</span>
            </label>
            <input
              v-model="form.appKey"
              type="password"
              placeholder="P-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
            <p class="text-xs text-txt-tertiary mt-1">KIS Developers에서 앱 등록 후 발급받은 App Key</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">
              App Secret <span class="text-red-500">*</span>
              <span v-if="secretSaved" class="ml-2 text-xs font-normal text-green-600 bg-green-50 px-1.5 py-0.5 rounded">저장됨</span>
            </label>
            <input
              v-model="form.appSecret"
              type="password"
              :placeholder="secretSaved ? '변경할 경우에만 입력 (비워두면 기존 값 유지)' : 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'"
              class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              :required="!secretSaved"
            />
            <p class="text-xs text-txt-tertiary mt-1">App Key에 대응하는 App Secret</p>
          </div>
        </div>
      </div>

      <!-- 섹션 2: 계좌 정보 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">계좌 정보</h3>
          <p class="text-xs text-txt-secondary mt-0.5">주문 기능을 사용하려면 계좌번호가 필요합니다. 시세 조회만 사용하는 경우 생략 가능합니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <div class="grid grid-cols-3 gap-4">
            <div class="col-span-2">
              <label class="block text-sm font-medium text-txt-primary mb-1">계좌번호</label>
              <input
                v-model="form.accountNo"
                type="text"
                placeholder="12345678"
                maxlength="8"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p class="text-xs text-txt-tertiary mt-1">계좌번호 8자리 (숫자만)</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">상품코드</label>
              <input
                v-model="form.accountProductCode"
                type="text"
                placeholder="01"
                maxlength="2"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p class="text-xs text-txt-tertiary mt-1">보통 01</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 3: 거래 환경 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">거래 환경</h3>
        </div>
        <div class="p-6">
          <div class="flex gap-3">
            <button
              type="button"
              @click="form.isVirtual = true"
              class="flex-1 py-3 px-4 rounded-xl border-2 text-sm font-medium transition-all"
              :class="form.isVirtual ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-border text-txt-secondary hover:border-border-hover'"
            >
              <div class="text-lg mb-1">🧪</div>
              <div class="font-semibold">모의투자</div>
              <div class="text-xs mt-0.5 opacity-70">가상 자금으로 테스트</div>
            </button>
            <button
              type="button"
              @click="form.isVirtual = false"
              class="flex-1 py-3 px-4 rounded-xl border-2 text-sm font-medium transition-all"
              :class="!form.isVirtual ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-border text-txt-secondary hover:border-border-hover'"
            >
              <div class="text-lg mb-1">💹</div>
              <div class="font-semibold">실계좌</div>
              <div class="text-xs mt-0.5 opacity-70">실제 자금으로 거래</div>
            </button>
          </div>
          <div v-if="!form.isVirtual" class="mt-3 p-3 bg-red-50 rounded-lg border border-red-200">
            <p class="text-xs text-red-600">⚠️ 실계좌 모드에서는 실제 자금으로 거래가 이루어집니다. 신중하게 사용하세요.</p>
          </div>
        </div>
      </div>

      <!-- 섹션 4: MLX (Apple Silicon 로컬 LLM) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">MLX (Apple Silicon 로컬 LLM)</h3>
          <p class="text-xs text-txt-secondary mt-0.5">매수/매도 판단에 사용할 로컬 LLM을 설정합니다. Apple Silicon 전용.</p>
        </div>
        <div class="p-6 space-y-4">

          <!-- MLX 연결 상태 -->
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="relative">
                <input type="checkbox" v-model="form.mlxEnabled" class="sr-only" />
                <div class="w-11 h-6 rounded-full transition-colors" :class="form.mlxEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
                <div class="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.mlxEnabled ? 'translate-x-5' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm font-medium text-txt-primary">MLX 활성화</span>
            </label>
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
              :class="llmConnected ? 'bg-green-100 text-green-700' : 'bg-surface-3 text-txt-secondary'">
              <span class="w-1.5 h-1.5 rounded-full" :class="llmConnected ? 'bg-green-500' : 'bg-txt-tertiary'"></span>
              {{ llmConnected ? '연결됨' : '미연결' }}
            </span>
          </div>

          <!-- 설치 안내 (미연결 시) -->
          <div v-if="!llmConnected" class="p-4 bg-amber-50 rounded-lg border border-amber-200">
            <p class="text-sm font-medium text-amber-800 mb-2">MLX 서버가 실행 중이 아닙니다</p>
            <div class="space-y-2">
              <div>
                <p class="text-xs text-amber-700 mb-1">Homebrew 설치 시 자동으로 구성됩니다. 개발 모드에서 수동 실행:</p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 bg-white px-3 py-1.5 rounded border border-amber-200 text-xs font-mono text-txt-primary">python3 -m venv ~/.stock-manager/venv && ~/.stock-manager/venv/bin/pip install mlx-lm</code>
                  <button type="button" @click="copyToClipboard('python3 -m venv ~/.stock-manager/venv && ~/.stock-manager/venv/bin/pip install mlx-lm')"
                    class="px-2 py-1.5 bg-amber-100 text-amber-700 rounded text-xs hover:bg-amber-200 transition whitespace-nowrap">
                    {{ copiedCmd === 'python3 -m venv ~/.stock-manager/venv && ~/.stock-manager/venv/bin/pip install mlx-lm' ? '복사됨' : '복사' }}
                  </button>
                </div>
              </div>
              <div>
                <p class="text-xs text-amber-700 mb-1">MLX 서버 기동:</p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 bg-white px-3 py-1.5 rounded border border-amber-200 text-xs font-mono text-txt-primary">~/.stock-manager/venv/bin/mlx_lm.server --port 8000 --model mlx-community/gemma-3-4b-it-4bit</code>
                  <button type="button" @click="copyToClipboard('~/.stock-manager/venv/bin/mlx_lm.server --port 8000 --model mlx-community/gemma-3-4b-it-4bit')"
                    class="px-2 py-1.5 bg-amber-100 text-amber-700 rounded text-xs hover:bg-amber-200 transition whitespace-nowrap">
                    복사
                  </button>
                </div>
              </div>
              <div>
                <p class="text-xs text-amber-700 mb-1">MLX 공식 문서:</p>
                <a href="https://github.com/ml-explore/mlx-lm" target="_blank"
                  class="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  github.com/ml-explore/mlx-lm
                </a>
              </div>
              <button type="button" @click="checkLlm"
                class="mt-1 px-3 py-1.5 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 transition">
                연결 재확인
              </button>
            </div>
          </div>

          <!-- MLX URL / 모델 설정 -->
          <div v-if="form.mlxEnabled" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">MLX 서버 URL</label>
              <input v-model="form.mlxUrl" type="text" placeholder="http://localhost:8000"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">사용 모델</label>
              <div class="flex gap-2">
                <select v-if="llmModels.length > 0" v-model="form.mlxModel"
                  class="flex-1 border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent">
                  <option v-for="m in llmModels" :key="m.name" :value="m.name">
                    {{ m.name }}<span v-if="m.size"> ({{ formatModelSize(m.size) }})</span>
                  </option>
                </select>
                <input v-else v-model="form.mlxModel" type="text" placeholder="mlx-community/gemma-3-4b-it-4bit"
                  class="flex-1 border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
                <button type="button" @click="loadLlmModels"
                  class="px-3 py-2 border border-border rounded-lg text-xs text-txt-secondary hover:bg-surface-2 transition whitespace-nowrap">
                  새로고침
                </button>
              </div>
            </div>
          </div>

          <!-- 모델 관리 (연결 시) -->
          <div v-if="llmConnected" class="border-t border-border-subtle pt-4 space-y-3">
            <div class="flex items-center justify-between">
              <h4 class="text-sm font-medium text-txt-primary">설치된 모델</h4>
              <button type="button" @click="loadLlmModels" class="text-xs text-accent hover:underline">새로고침</button>
            </div>

            <!-- 모델 목록 -->
            <div v-if="llmModels.length === 0" class="text-sm text-txt-tertiary py-2">설치된 모델이 없습니다. 아래에서 다운로드하세요.</div>
            <div v-else class="space-y-1">
              <div v-for="m in llmModels" :key="m.name"
                class="flex items-center justify-between px-3 py-2 rounded-lg"
                :class="form.mlxModel === m.name ? 'bg-blue-50 border border-blue-200' : 'bg-surface-2'">
                <div class="flex items-center gap-2">
                  <span v-if="form.mlxModel === m.name" class="text-xs text-accent font-medium">사용 중</span>
                  <span class="text-sm font-mono text-txt-primary">{{ m.name }}</span>
                  <span v-if="m.size" class="text-xs text-txt-tertiary">{{ formatModelSize(m.size) }}</span>
                </div>
                <div class="flex gap-2">
                  <button v-if="form.mlxModel !== m.name" type="button" @click="form.mlxModel = m.name"
                    class="text-xs text-accent hover:underline">선택</button>
                  <button type="button" @click="deleteModel(m.name)"
                    class="text-xs text-red-500 hover:underline">삭제</button>
                </div>
              </div>
            </div>

            <!-- 모델 다운로드 -->
            <div class="bg-surface-2 rounded-lg p-4 space-y-3">
              <h4 class="text-sm font-medium text-txt-primary">모델 다운로드</h4>
              <div class="flex gap-2 flex-wrap">
                <button type="button" v-for="rec in recommendedModels" :key="rec.name"
                  @click="pullModelName = rec.name"
                  class="px-3 py-1.5 rounded-lg text-xs font-medium border transition"
                  :class="pullModelName === rec.name ? 'bg-primary text-white border-primary' : 'bg-surface-1 text-txt-secondary border-border hover:bg-surface-2'">
                  {{ rec.name }} <span class="text-txt-tertiary font-normal">({{ rec.size }})</span>
                </button>
              </div>
              <div class="flex gap-2">
                <input v-model="pullModelName" type="text" placeholder="모델명 (예: mlx-community/gemma-3-4b-it-4bit)"
                  class="flex-1 border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
                <button type="button" @click="pullModel" :disabled="pulling || !pullModelName"
                  class="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition whitespace-nowrap">
                  {{ pulling ? '다운로드 중...' : '다운로드' }}
                </button>
              </div>

              <!-- 다운로드 진행 상태 -->
              <div v-if="pullStatus" class="space-y-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-txt-secondary">{{ pullStatus }}</span>
                  <span v-if="pullProgress > 0" class="text-txt-secondary">{{ pullProgress }}%</span>
                </div>
                <div v-if="pullProgress > 0" class="w-full bg-surface-3 rounded-full h-2 overflow-hidden">
                  <div class="h-full bg-primary rounded-full transition-all" :style="{ width: pullProgress + '%' }"></div>
                </div>
              </div>
              <div v-if="pullError" class="text-xs text-red-600">{{ pullError }}</div>
              <div v-if="pullSuccess" class="text-xs text-green-600">{{ pullSuccess }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션: DART (금융감독원 공시) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">DART (금융감독원 공시)</h3>
          <p class="text-xs text-txt-secondary mt-0.5">
            재무제표(매출, 영업이익, ROE)와 실시간 공시 데이터를 조회합니다.
            <a href="https://opendart.fss.or.kr/" target="_blank" class="text-accent hover:underline ml-1">API 키 발급</a>
          </p>
        </div>
        <div class="p-6 space-y-4">
          <label class="flex items-center gap-3 cursor-pointer">
            <div class="relative inline-block">
              <input type="checkbox" v-model="form.dartEnabled" class="sr-only" />
              <div class="w-9 h-5 rounded-full transition-colors" :class="form.dartEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
              <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.dartEnabled ? 'translate-x-4' : 'translate-x-0'"></div>
            </div>
            <span class="text-sm font-medium text-txt-primary">DART 활성화</span>
            <span v-if="dartKeySaved" class="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-600">API 연결됨</span>
          </label>
          <div v-if="form.dartEnabled" class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">
                DART API Key
                <span v-if="dartKeySaved" class="ml-2 text-xs font-normal text-green-600 bg-green-50 px-1.5 py-0.5 rounded">저장됨</span>
              </label>
              <input v-model="form.dartApiKey" type="password"
                :placeholder="dartKeySaved ? '변경할 경우에만 입력' : 'DART OpenAPI 인증키 입력'"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
              <p class="text-xs text-txt-tertiary mt-1">opendart.fss.or.kr에서 발급받은 인증키</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 5: AI 분석 옵션 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">AI 분석 옵션</h3>
          <p class="text-xs text-txt-secondary mt-0.5">LLM 매매 판단의 투자 스타일과 분석 방식을 설정합니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-2">투자 스타일</label>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
              <button type="button" v-for="opt in [
                { v: 'balanced', l: '균형형', d: 'RSI·MACD 등 종합 판단' },
                { v: 'value', l: '가치투자', d: '저PER·저PBR 안전마진 중시' },
                { v: 'growth', l: '성장투자', d: '매출 성장·혁신 기업 선호' },
                { v: 'momentum', l: '모멘텀', d: '추세 추종·돌파 패턴 중심' },
              ]" :key="opt.v" @click="form.investmentStyle = opt.v"
                class="py-2.5 px-3 rounded-lg border-2 text-center transition-all"
                :class="form.investmentStyle === opt.v ? 'border-blue-400 bg-blue-50' : 'border-border hover:border-border-hover'">
                <div class="text-sm font-medium" :class="form.investmentStyle === opt.v ? 'text-blue-700' : 'text-txt-primary'">{{ opt.l }}</div>
                <div class="text-xs mt-0.5" :class="form.investmentStyle === opt.v ? 'text-blue-500' : 'text-txt-tertiary'">{{ opt.d }}</div>
              </button>
            </div>
          </div>
          <div>
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="relative inline-block">
                <input type="checkbox" v-model="form.debateMode" class="sr-only" />
                <div class="w-9 h-5 rounded-full transition-colors" :class="form.debateMode ? 'bg-primary' : 'bg-surface-3'"></div>
                <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.debateMode ? 'translate-x-4' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm font-medium text-txt-primary">토론 모드 (강세/약세 분석)</span>
            </label>
            <p class="text-xs text-txt-secondary mt-1 ml-12">LLM이 강세·약세 관점을 각각 분석한 뒤 종합 판단합니다. 정확도가 높아지지만 분석 시간이 3배로 늘어납니다.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">손절 기준 (%)</label>
            <div class="flex items-center gap-3">
              <input v-model.number="form.stopLossPercent" type="number" min="1" max="20" step="0.5"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-xs text-txt-secondary">매입가 대비 -{{ form.stopLossPercent }}% 도달 시 자동 손절 매도</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 6: 자동매매 설정 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">자동매매</h3>
          <p class="text-xs text-txt-secondary mt-0.5">자동매매 활성화 및 리스크 관리 설정</p>
        </div>
        <div class="p-6 space-y-4">
          <label class="flex items-center gap-3 cursor-pointer">
            <div class="relative">
              <input type="checkbox" v-model="form.autoTradeEnabled" class="sr-only" />
              <div class="w-11 h-6 rounded-full transition-colors" :class="form.autoTradeEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
              <div class="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.autoTradeEnabled ? 'translate-x-5' : 'translate-x-0'"></div>
            </div>
            <span class="text-sm font-medium text-txt-primary">자동매매 활성화</span>
          </label>
          <div v-if="!form.autoTradeEnabled" class="p-3 bg-surface-2 rounded-lg border border-border">
            <p class="text-xs text-txt-secondary">자동매매가 비활성화되어 있습니다. 매매 신호는 생성되지만 주문은 실행되지 않습니다.</p>
          </div>
          <div v-if="form.autoTradeEnabled" class="p-3 bg-red-50 rounded-lg border border-red-200">
            <p class="text-xs text-red-600">⚠️ 자동매매가 활성화되면 LLM 판단에 따라 실제 주문이 실행됩니다.</p>
          </div>
          <div class="grid grid-cols-3 gap-4">
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">총 최대 투자금액</label>
              <input v-model.number="form.autoTradeMaxInvestment" type="number" min="0" step="1000000"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p class="text-xs text-txt-tertiary mt-1">{{ formatCurrency(form.autoTradeMaxInvestment) }}</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">종목당 최대</label>
              <input v-model.number="form.autoTradeMaxPerStock" type="number" min="0" step="500000"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p class="text-xs text-txt-tertiary mt-1">{{ formatCurrency(form.autoTradeMaxPerStock) }}</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">일일 최대 거래</label>
              <input v-model.number="form.autoTradeMaxDailyTrades" type="number" min="1"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p class="text-xs text-txt-tertiary mt-1">{{ form.autoTradeMaxDailyTrades }}회</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 7: 스케줄 설정 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">매매 스케줄</h3>
          <p class="text-xs text-txt-secondary mt-0.5">시장별 자동 분석/매매 스케줄 (주말 제외)</p>
        </div>
        <div class="p-6 space-y-6">
          <!-- KRX -->
          <div>
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold text-txt-primary">🇰🇷 KRX (한국거래소)</span>
                <span class="text-xs text-txt-tertiary">09:00 ~ 15:30 KST</span>
              </div>
              <label class="flex items-center gap-2 cursor-pointer">
                <div class="relative">
                  <input type="checkbox" v-model="form.scheduleKrx.enabled" class="sr-only" />
                  <div class="w-9 h-5 rounded-full transition-colors" :class="form.scheduleKrx.enabled ? 'bg-primary' : 'bg-surface-3'"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.scheduleKrx.enabled ? 'translate-x-4' : 'translate-x-0'"></div>
                </div>
              </label>
            </div>
            <div v-if="form.scheduleKrx.enabled" class="grid grid-cols-2 gap-2">
              <label v-for="s in scheduleSlots" :key="'krx-'+s.key"
                class="flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer"
                :class="form.scheduleKrx[s.key] ? 'border-blue-200 bg-blue-50' : 'border-border'">
                <input type="checkbox" v-model="form.scheduleKrx[s.key]" class="rounded text-accent" />
                <div>
                  <span class="font-medium text-txt-primary">{{ s.label }}</span>
                  <span class="text-txt-tertiary ml-1">{{ s.krxTime }}</span>
                </div>
              </label>
            </div>
          </div>
          <!-- NYSE -->
          <div class="border-t border-border-subtle pt-6">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold text-txt-primary">🇺🇸 NYSE/NASDAQ</span>
                <span class="text-xs text-txt-tertiary">09:30 ~ 16:00 ET</span>
              </div>
              <label class="flex items-center gap-2 cursor-pointer">
                <div class="relative">
                  <input type="checkbox" v-model="form.scheduleNyse.enabled" class="sr-only" />
                  <div class="w-9 h-5 rounded-full transition-colors" :class="form.scheduleNyse.enabled ? 'bg-primary' : 'bg-surface-3'"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.scheduleNyse.enabled ? 'translate-x-4' : 'translate-x-0'"></div>
                </div>
              </label>
            </div>
            <div v-if="form.scheduleNyse.enabled" class="grid grid-cols-2 gap-2">
              <label v-for="s in scheduleSlots" :key="'nyse-'+s.key"
                class="flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer"
                :class="form.scheduleNyse[s.key] ? 'border-blue-200 bg-blue-50' : 'border-border'">
                <input type="checkbox" v-model="form.scheduleNyse[s.key]" class="rounded text-accent" />
                <div>
                  <span class="font-medium text-txt-primary">{{ s.label }}</span>
                  <span class="text-txt-tertiary ml-1">{{ s.nyseTime }}</span>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션: 포트폴리오 운영 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">포트폴리오 운영</h3>
          <p class="text-xs text-txt-secondary mt-0.5">포트폴리오 분산 투자 및 리밸런싱 정책을 설정합니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <!-- 최대 보유 종목 수 -->
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">최대 보유 종목 수</label>
            <input v-model.number="form.portfolioMaxHoldings" type="number" min="3" max="50"
              class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
            <p class="text-xs text-txt-tertiary mt-1">포트폴리오에 보유할 수 있는 최대 종목 수</p>
          </div>
          <!-- 종목당 최대 비율 -->
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">종목당 최대 비율</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.portfolioMaxPerStockPercent" type="number" min="5" max="50"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">총 자산 대비 단일 종목 최대 투자 비율</p>
          </div>
          <!-- 섹터당 최대 비율 -->
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">섹터당 최대 비율</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.portfolioMaxSectorPercent" type="number" min="20" max="80"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">동일 섹터에 집중 투자할 수 있는 최대 비율</p>
          </div>
          <!-- 최소 현금 보유 비율 -->
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">최소 현금 보유 비율</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.portfolioMinCashPercent" type="number" min="0" max="50"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">투자 후에도 유지해야 할 최소 현금 비율</p>
          </div>
          <!-- 자동 리밸런싱 -->
          <div>
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="relative inline-block">
                <input type="checkbox" v-model="form.portfolioRebalanceEnabled" class="sr-only" />
                <div class="w-9 h-5 rounded-full transition-colors" :class="form.portfolioRebalanceEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
                <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.portfolioRebalanceEnabled ? 'translate-x-4' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm font-medium text-txt-primary">자동 리밸런싱</span>
            </label>
            <p class="text-xs text-txt-secondary mt-1 ml-12">주간 1회 비중 초과/부족 종목 자동 제안</p>
          </div>
        </div>
      </div>

      <!-- 섹션: 매매 원칙 -->
      <TradingRulesSection
        v-model:tradingRulesEnabled="form.tradingRulesEnabled"
        v-model:tradingRulesStrictMode="form.tradingRulesStrictMode"
        v-model:gapThresholdPercent="form.gapThresholdPercent"
        v-model:volumeSurgeRatio="form.volumeSurgeRatio"
        v-model:lowVolumeRatio="form.lowVolumeRatio"
        v-model:sidewaysAtrPercent="form.sidewaysAtrPercent"
      />

      <!-- 섹션: 매도 규칙 (v4.8.0) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-semibold text-txt-primary">매도 규칙 (Hard Rules)</h3>
              <p class="text-xs text-txt-secondary mt-0.5">LLM 없이 즉시 매도하는 4가지 조건. 매수 판단보다 우선 실행됩니다.</p>
            </div>
            <label class="flex items-center gap-2 cursor-pointer">
              <div class="relative inline-block">
                <input type="checkbox" v-model="form.sellRulesEnabled" class="sr-only" />
                <div class="w-9 h-5 rounded-full transition-colors" :class="form.sellRulesEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
                <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.sellRulesEnabled ? 'translate-x-4' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm text-txt-primary">활성화</span>
            </label>
          </div>
        </div>
        <div class="p-6 space-y-4" :class="{ 'opacity-50 pointer-events-none': !form.sellRulesEnabled }">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">목표 수익률</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.targetProfitRate" type="number" step="0.1" min="0.5" max="50"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">매수가 대비 +N% 도달 시 전량 매도 (기본 3%)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">손절 기준 (hard stop-loss)</label>
            <div class="flex items-center gap-2">
              <span class="text-sm text-txt-secondary">-</span>
              <input v-model.number="form.hardStopLossRate" type="number" step="0.1" min="0.5" max="50"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">매수가 대비 -N% 이하 시 전량 매도 (기본 2% — 긴급 손절 3%보다 먼저 발동)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">트레일링 스탑</label>
            <div class="flex items-center gap-2">
              <span class="text-sm text-txt-secondary">고점 -</span>
              <input v-model.number="form.trailingStopRate" type="number" step="0.1" min="0.3" max="20"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">보유 중 관측된 최고가에서 -N% 하락 시 전량 매도 (기본 1.5%)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">최대 보유 시간</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.maxHoldMinutes" type="number" min="5" max="1440"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">분</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">매수 후 N분 경과 시 손익 무관 전량 매도 (기본 60분 — 단타 목적)</p>
          </div>
        </div>
      </div>

      <!-- 섹션: 포지션 사이징 (v4.8.0) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">포지션 사이징</h3>
          <p class="text-xs text-txt-secondary mt-0.5">매수 시 예산·종목 수·현금 비율을 강제합니다. 잔고 전액 단일 종목 투입 방지.</p>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">단일 종목 최대 투자 비율</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.positionMaxRatio" type="number" min="5" max="100"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">전체 예산의 N% 이하로 단일 종목 투자 제한 (기본 25%)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">최소 현금 보유 비율</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.positionMinCashRatio" type="number" min="0" max="80"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">%</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">현금 비율이 이 값 미만이면 신규 매수 금지 (기본 20%)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">최대 동시 보유 종목 수</label>
            <input v-model.number="form.positionMaxPositions" type="number" min="1" max="20"
              class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
            <p class="text-xs text-txt-tertiary mt-1">보유 종목 수가 이 값 이상이면 신규 매수 금지 (기본 3종목 — 집중 투자 전략)</p>
          </div>
        </div>
      </div>

      <!-- 섹션: 동적 스크리닝 (v4.8.0) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-semibold text-txt-primary">동적 종목 스크리닝</h3>
              <p class="text-xs text-txt-secondary mt-0.5">시장 국면(RISING/FLAT/FALLING)에 따라 후보 종목을 자동 스크리닝합니다.</p>
            </div>
            <label class="flex items-center gap-2 cursor-pointer">
              <div class="relative inline-block">
                <input type="checkbox" v-model="form.dynamicScreeningEnabled" class="sr-only" />
                <div class="w-9 h-5 rounded-full transition-colors" :class="form.dynamicScreeningEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
                <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.dynamicScreeningEnabled ? 'translate-x-4' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm text-txt-primary">활성화</span>
            </label>
          </div>
        </div>
        <div class="p-6 space-y-4" :class="{ 'opacity-50 pointer-events-none': !form.dynamicScreeningEnabled }">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">거래량 비율 최소값 (RISING 국면)</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.screeningVolumeRatioMin" type="number" step="0.1" min="1" max="10"
                class="w-24 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">배</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">상승장에서 5일 평균 거래량의 N배 이상만 후보로 선정 (기본 1.5배 = 150%)</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">최소 시가총액 (FLAT 국면)</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.screeningMinMarketCap" type="number" min="0"
                class="w-32 border border-border rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">억원</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">박스권에서 시가총액 N억 이상만 후보로 선정 (기본 500억 — 유동성 확보)</p>
          </div>
          <div class="bg-surface-2 rounded-lg p-3 text-xs text-txt-secondary">
            <p class="font-semibold mb-1">국면 판별 기준 (KOSPI + KOSDAQ 평균 등락률):</p>
            <ul class="space-y-0.5 ml-2">
              <li>• <span class="text-profit">RISING</span>: ≥ +0.5% — 모멘텀 종목 (등락률 +1~5%, 거래량 급증)</li>
              <li>• <span class="text-txt-tertiary">FLAT</span>: ±0.5% — 박스권 종목 (볼린저 하단, RSI ≤ 30, 대형주)</li>
              <li>• <span class="text-loss">FALLING</span>: ≤ -0.5% — 신규 매수 건너뜀 (현금 보유)</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 섹션: 가상매매 (v4.10.0) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-semibold text-txt-primary">가상매매 (Paper Trading)</h3>
              <p class="text-xs text-txt-secondary mt-0.5">추천 BUY 신호가 발생했지만 실매매가 안 된 종목을 자동으로 가상 매수하여 학습 데이터로 활용합니다.</p>
            </div>
            <label class="flex items-center gap-2 cursor-pointer">
              <div class="relative inline-block">
                <input type="checkbox" v-model="form.paperTradingEnabled" class="sr-only" />
                <div class="w-9 h-5 rounded-full transition-colors" :class="form.paperTradingEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
                <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.paperTradingEnabled ? 'translate-x-4' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm text-txt-primary">활성화</span>
            </label>
          </div>
        </div>
        <div class="p-6 space-y-4" :class="{ 'opacity-50 pointer-events-none': !form.paperTradingEnabled }">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-1">종목당 가상매수 금액 (KRW)</label>
            <div class="flex items-center gap-2">
              <input v-model.number="form.paperTradeAmount" type="number" min="1" step="100000"
                class="w-48 border border-border rounded-lg px-3 py-2 text-sm tabular-nums text-right focus:outline-none focus:ring-2 focus:ring-accent" />
              <span class="text-sm text-txt-secondary">원</span>
              <span class="text-xs text-txt-tertiary">({{ (form.paperTradeAmount / 10000).toLocaleString() }}만원)</span>
            </div>
            <p class="text-xs text-txt-tertiary mt-1">가상매수 시 종목당 투자 금액. 해외 종목은 USD/KRW 환율로 환산하여 수량 계산. <strong>한도 제한 없음</strong> — 기본 100만원, 원하는 만큼 설정 가능.</p>
          </div>
          <div class="bg-surface-2 rounded-lg p-3 text-xs text-txt-secondary">
            <p class="font-semibold mb-2">가상매매 규칙:</p>
            <ul class="space-y-1 ml-2">
              <li>• <strong>중복 방지</strong>: 실매매로 보유 중인 종목은 가상매매하지 않습니다 (transactions/auto_trades 합산 체크)</li>
              <li>• <strong>매도</strong>: 위 매도 규칙 4종(목표수익률/손절/트레일링/시간초과)을 동일하게 적용</li>
              <li>• <strong>학습 합산</strong>: 정확도 평가/가중치 최적화 시 가상매매 데이터도 자동 합산 (signal_performance.is_paper)</li>
              <li>• <strong>전용 화면</strong>: Portfolio · Transactions · 차트에서 실/가상 구분 표시</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 섹션: 데이터 동기화 (NAS) -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">데이터 동기화 (NAS)</h3>
          <p class="text-xs text-txt-secondary mt-0.5">NAS에 데이터를 자동으로 백업/동기화합니다. 여러 기기에서 동일한 데이터를 유지할 수 있습니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <!-- NAS 동기화 활성화 토글 -->
          <label class="flex items-center gap-3 cursor-pointer">
            <div class="relative">
              <input type="checkbox" v-model="form.nasSyncEnabled" class="sr-only" />
              <div class="w-11 h-6 rounded-full transition-colors" :class="form.nasSyncEnabled ? 'bg-primary' : 'bg-surface-3'"></div>
              <div class="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.nasSyncEnabled ? 'translate-x-5' : 'translate-x-0'"></div>
            </div>
            <span class="text-sm font-medium text-txt-primary">NAS 동기화 활성화</span>
          </label>

          <div v-if="form.nasSyncEnabled" class="space-y-4">
            <!-- NAS 경로 -->
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">NAS 경로</label>
              <div class="flex gap-2">
                <input v-model="form.nasSyncPath" type="text" placeholder="/Volumes/NAS/StockManager"
                  class="flex-1 border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
                <button type="button" @click="validateNasPath" :disabled="validating || !form.nasSyncPath"
                  class="px-4 py-2 border border-border rounded-lg text-sm font-medium text-txt-secondary hover:bg-surface-2 disabled:opacity-50 transition whitespace-nowrap">
                  {{ validating ? '확인 중...' : '경로 테스트' }}
                </button>
              </div>
              <p v-if="syncValidateResult" class="text-xs mt-1"
                :class="syncValidateResult.startsWith('OK') ? 'text-green-600' : 'text-red-600'">
                {{ syncValidateResult }}
              </p>
              <p class="text-xs text-txt-tertiary mt-1">마운트된 NAS 공유 폴더 경로를 입력하세요</p>
            </div>

            <!-- 기기 ID -->
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">기기 ID</label>
              <input v-model="form.nasDeviceId" type="text" placeholder="hostname"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
              <p class="text-xs text-txt-tertiary mt-1">이 기기를 식별하는 고유 이름 (비워두면 호스트명 사용)</p>
            </div>

            <!-- 동기화 시간 -->
            <div>
              <label class="block text-sm font-medium text-txt-primary mb-1">동기화 시간 (Cron 표현식)</label>
              <input v-model="form.nasSyncTime" type="text" placeholder="0 20 * * *"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
              <p class="text-xs text-txt-tertiary mt-1">기본값: 매일 오후 8시 (0 20 * * *)</p>
            </div>

            <!-- 마지막 동기화 정보 -->
            <div v-if="syncStatus?.lastSync" class="bg-surface-2 rounded-lg p-4">
              <h4 class="text-sm font-medium text-txt-primary mb-2">마지막 동기화 정보</h4>
              <div class="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span class="text-txt-secondary">동기화 시각:</span>
                  <span class="ml-1 text-txt-primary font-medium">{{ new Date(syncStatus.lastSync.lastSyncAt).toLocaleString('ko-KR') }}</span>
                </div>
                <div>
                  <span class="text-txt-secondary">기기:</span>
                  <span class="ml-1 text-txt-primary font-medium">{{ syncStatus.lastSync.deviceId }}</span>
                </div>
                <div>
                  <span class="text-txt-secondary">테이블:</span>
                  <span class="ml-1 text-txt-primary font-medium">{{ syncStatus.lastSync.tablesExported }}개</span>
                </div>
                <div>
                  <span class="text-txt-secondary">레코드:</span>
                  <span class="ml-1 text-txt-primary font-medium">{{ syncStatus.lastSync.totalRecords.toLocaleString() }}건</span>
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-txt-tertiary">아직 동기화된 기록이 없습니다.</div>

            <!-- 동기화 / 백업 버튼 -->
            <div class="space-y-2">
              <div class="flex flex-wrap gap-2">
                <button type="button" @click="runSyncNow" :disabled="syncing"
                  class="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition">
                  {{ syncing ? '처리 중...' : '🌐 NAS 동기화' }}
                </button>
                <button type="button" @click="runLocalBackup" :disabled="syncing"
                  class="px-4 py-2 bg-surface-2 text-txt-primary border border-border rounded-lg text-sm font-medium hover:bg-surface-3 disabled:opacity-50 transition">
                  {{ syncing ? '처리 중...' : '💾 로컬 백업 (API 키 포함)' }}
                </button>
              </div>
              <p class="text-xs text-txt-tertiary">
                <strong>NAS 동기화</strong>: 외부/공유 저장소용 — API 키가 마스킹됩니다.<br />
                <strong>로컬 백업</strong>: brew 업그레이드 후 복구를 위해 API 키가 포함됩니다. 안전한 개인 저장소에만 사용하세요.
              </p>
              <p v-if="syncResultMessage" class="text-xs mt-2"
                :class="syncResultError ? 'text-profit' : 'text-green-500'">
                {{ syncResultMessage }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션: 데이터 새로고침 -->
      <div class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-surface-2 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-primary">데이터 새로고침</h3>
          <p class="text-xs text-txt-secondary mt-0.5">실시간 데이터 업데이트 방식과 주기를 설정합니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-txt-primary mb-2">자동 새로고침 간격</label>
            <div class="grid grid-cols-4 gap-2">
              <button type="button" v-for="opt in refreshOptions" :key="opt.value"
                @click="selectedRefreshInterval = opt.value"
                class="py-2.5 px-3 rounded-xl border-2 text-sm font-medium transition-all text-center"
                :class="selectedRefreshInterval === opt.value
                  ? 'border-accent bg-accent-dim text-accent'
                  : 'border-border text-txt-secondary hover:border-border-hover'">
                {{ opt.label }}
              </button>
            </div>
            <p class="text-xs text-txt-tertiary mt-2">WebSocket 연결 시 서버 푸시로 즉시 업데이트되며, 연결 끊김 시 선택한 간격으로 폴링합니다.</p>
          </div>
        </div>
      </div>

      <!-- 저장 버튼 -->
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="saving"
          class="bg-primary text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition"
        >
          {{ saving ? '저장 중...' : '설정 저장' }}
        </button>
        <span v-if="saveMessage" class="text-sm" :class="saveError ? 'text-red-500' : 'text-green-600'">
          {{ saveMessage }}
        </span>
      </div>
    </form>

    <!-- 전략 관리 -->
    <div class="mt-8 bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
      <div class="px-6 py-4 bg-surface-2 border-b border-border">
        <h3 class="text-sm font-semibold text-txt-primary">전략 내보내기 / 가져오기</h3>
        <p class="text-xs text-txt-secondary mt-0.5">학습된 가중치와 설정을 다른 컴퓨터에 이식하거나, LoRA 학습 데이터를 추출합니다.</p>
      </div>
      <div class="p-6 space-y-4">
        <!-- 전체 설정 백업/복원 (API 키 포함) -->
        <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <h4 class="text-sm font-semibold text-amber-800 mb-2">전체 설정 백업/복원 (API 키 포함)</h4>
          <p class="text-xs text-amber-600 mb-3">다른 컴퓨터에서 동일한 환경으로 운영할 수 있습니다. 파일에 API 키가 포함되므로 안전하게 보관하세요.</p>
          <div class="flex gap-2 flex-wrap">
            <button @click="doBackup" :disabled="backupLoading"
              class="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50">
              {{ backupLoading ? '백업 중...' : '전체 백업 다운로드' }}
            </button>
            <div class="flex gap-2">
              <input type="file" ref="restoreFileInput" accept=".json" @change="onRestoreFileSelect"
                class="text-sm border border-amber-300 rounded-lg px-3 py-2 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-amber-100 file:text-amber-700" />
              <button @click="doRestore" :disabled="!restoreFile || restoreLoading"
                class="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50">
                {{ restoreLoading ? '복원 중...' : '복원' }}
              </button>
            </div>
          </div>
          <p v-if="backupMsg" class="text-xs mt-2" :class="backupError ? 'text-red-600' : 'text-green-600'">{{ backupMsg }}</p>
        </div>

        <!-- 전략 내보내기 (credentials 제외) -->
        <div class="border-t border-border-subtle pt-4">
          <div class="flex items-center gap-3">
            <button @click="doExportStrategy" :disabled="strategyExporting"
              class="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover disabled:opacity-50">
              {{ strategyExporting ? '내보내는 중...' : '전략 내보내기 (API키 미포함)' }}
            </button>
            <span v-if="strategyExportMsg" class="text-xs text-green-600">{{ strategyExportMsg }}</span>
          </div>
        </div>

        <!-- 전략 가져오기 -->
        <div>
          <label class="block text-sm font-medium text-txt-primary mb-1">전략 가져오기</label>
          <div class="flex gap-2">
            <input type="file" ref="strategyFileInput" accept=".json" @change="onStrategyFileSelect"
              class="flex-1 text-sm border border-border rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-blue-50 file:text-blue-700" />
            <button @click="doImportStrategy" :disabled="!strategyFile || strategyImporting"
              class="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50">
              {{ strategyImporting ? '적용 중...' : '적용' }}
            </button>
          </div>
          <p v-if="strategyImportMsg" class="text-xs mt-1" :class="strategyImportError ? 'text-red-600' : 'text-green-600'">
            {{ strategyImportMsg }}
          </p>
        </div>

        <!-- LoRA 학습 데이터 -->
        <div class="border-t border-border-subtle pt-4">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-medium text-txt-primary">LoRA 학습 데이터</span>
            <button @click="loadLoraStatus" class="text-xs text-accent hover:underline">새로고침</button>
          </div>
          <div v-if="loraStatus" class="space-y-2">
            <div class="flex items-center gap-3">
              <div class="flex-1 bg-surface-3 rounded-full h-3 overflow-hidden">
                <div class="h-full rounded-full transition-all" :class="loraStatus.ready ? 'bg-green-500' : 'bg-blue-500'"
                  :style="{ width: Math.min(loraStatus.percent, 100) + '%' }"></div>
              </div>
              <span class="text-xs text-txt-secondary w-24 text-right">{{ loraStatus.count.toLocaleString() }} / 5,000</span>
            </div>
            <p v-if="loraStatus.ready" class="text-xs text-green-600">학습 데이터 준비 완료! 내보내기 가능합니다.</p>
            <p v-else class="text-xs text-txt-tertiary">데이터가 충분히 쌓이면 자동으로 LoRA 학습 데이터가 생성됩니다.</p>
            <button v-if="loraStatus.ready" @click="doExportLora" :disabled="loraExporting"
              class="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 disabled:opacity-50">
              {{ loraExporting ? '생성 중...' : 'LoRA 데이터 내보내기 (JSONL)' }}
            </button>
            <p v-if="loraExportMsg" class="text-xs text-green-600">{{ loraExportMsg }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- KIS API 안내 -->
    <div class="mt-8 p-4 bg-blue-50 rounded-xl border border-blue-200">
      <h4 class="text-sm font-semibold text-blue-800 mb-2">KIS API 발급 방법</h4>
      <ol class="text-xs text-blue-700 space-y-1 list-decimal list-inside">
        <li>한국투자증권 계좌 개설 (온라인 가능)</li>
        <li><a href="https://apiportal.koreainvestment.com" target="_blank" class="underline">KIS Developers 포털</a> 접속 후 로그인</li>
        <li>앱 등록 → API 신청 → App Key / App Secret 발급</li>
        <li>모의계좌 사용 시: 모의계좌 신청 별도 필요</li>
      </ol>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { chartApi, analysisApi, feedbackApi, nasSyncApi } from '@/api';
import TradingRulesSection from '@/components/TradingRulesSection.vue';
import { setRefreshInterval, getRefreshInterval } from '@/composables/useAutoRefresh';

const configStatus = ref({ configured: false, isVirtual: true, hasAccount: false });

// 데이터 새로고침 설정
const refreshOptions = [
  { label: '10초', value: 10000 },
  { label: '30초', value: 30000 },
  { label: '60초', value: 60000 },
  { label: '수동', value: 0 },
];
const selectedRefreshInterval = ref(getRefreshInterval());

watch(selectedRefreshInterval, (val) => {
  setRefreshInterval(val);
});

const dartKeySaved = ref(false);

// 전체 백업/복원
const backupLoading = ref(false);
const restoreFile = ref<any>(null);
const restoreFileInput = ref<HTMLInputElement | null>(null);
const restoreLoading = ref(false);
const backupMsg = ref('');
const backupError = ref(false);

async function doBackup() {
  backupLoading.value = true;
  backupMsg.value = '';
  backupError.value = false;
  try {
    const { data } = await feedbackApi.backupConfig();
    const blob = new Blob([JSON.stringify(data.config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    backupMsg.value = '백업 파일 다운로드 완료';
  } catch (err: any) {
    backupMsg.value = err.response?.data?.error || '백업 실패';
    backupError.value = true;
  }
  backupLoading.value = false;
}

function onRestoreFileSelect(e: Event) {
  restoreFile.value = (e.target as HTMLInputElement).files?.[0] || null;
}

async function doRestore() {
  if (!restoreFile.value) return;
  if (!confirm('현재 설정을 백업 파일의 내용으로 덮어씁니다. 계속하시겠습니까?')) return;
  restoreLoading.value = true;
  backupMsg.value = '';
  backupError.value = false;
  try {
    const text = await restoreFile.value.text();
    const json = JSON.parse(text);
    const { data } = await feedbackApi.restoreConfig(json.config || json);
    backupMsg.value = '복원 완료 — 페이지를 새로고침합니다';
    backupError.value = false;
    setTimeout(() => location.reload(), 1500);
  } catch (err: any) {
    backupMsg.value = err.response?.data?.error || '복원 실패';
    backupError.value = true;
  }
  restoreLoading.value = false;
}

// 전략 내보내기/가져오기
const strategyExporting = ref(false);
const strategyExportMsg = ref('');
const strategyFile = ref<any>(null);
const strategyFileInput = ref<HTMLInputElement | null>(null);
const strategyImporting = ref(false);
const strategyImportMsg = ref('');
const strategyImportError = ref(false);
const loraStatus = ref<any>(null);
const loraExporting = ref(false);
const loraExportMsg = ref('');

// NAS 동기화
const syncStatus = ref<any>(null);
const syncValidateResult = ref('');
const syncing = ref(false);
const validating = ref(false);
const syncResultMessage = ref('');
const syncResultError = ref(false);

async function doExportStrategy() {
  strategyExporting.value = true;
  strategyExportMsg.value = '';
  try {
    const { data } = await feedbackApi.exportStrategy();
    // 브라우저에서 다운로드
    const blob = new Blob([JSON.stringify(data.strategy, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strategy-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    strategyExportMsg.value = '다운로드 완료';
  } catch (err: any) {
    strategyExportMsg.value = err.response?.data?.error || '내보내기 실패';
  }
  strategyExporting.value = false;
}

function onStrategyFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  strategyFile.value = input.files?.[0] || null;
}

async function doImportStrategy() {
  if (!strategyFile.value) return;
  strategyImporting.value = true;
  strategyImportMsg.value = '';
  strategyImportError.value = false;
  try {
    const text = await strategyFile.value.text();
    const json = JSON.parse(text);
    const { data } = await feedbackApi.importStrategy(json.strategy || json);
    strategyImportMsg.value = data.message || '적용 완료';
    strategyImportError.value = false;
  } catch (err: any) {
    strategyImportMsg.value = err.response?.data?.error || '가져오기 실패';
    strategyImportError.value = true;
  }
  strategyImporting.value = false;
}

async function loadLoraStatus() {
  try {
    const { data } = await feedbackApi.getLoraStatus();
    loraStatus.value = data;
  } catch {}
}

async function doExportLora() {
  loraExporting.value = true;
  loraExportMsg.value = '';
  try {
    const { data } = await feedbackApi.exportLora();
    loraExportMsg.value = data.message;
  } catch (err: any) {
    loraExportMsg.value = err.response?.data?.error || '생성 실패';
  }
  loraExporting.value = false;
}
const saving = ref(false);
const saveMessage = ref('');
const saveError = ref(false);

const form = ref({
  appKey: '',
  appSecret: '',
  accountNo: '',
  accountProductCode: '01',
  isVirtual: true,

  mlxUrl: 'http://localhost:8000',
  mlxModel: 'mlx-community/gemma-3-4b-it-4bit',
  mlxEnabled: true,

  dartApiKey: '',
  dartEnabled: false,

  investmentStyle: 'balanced',
  debateMode: false,
  stopLossPercent: 3,

  autoTradeEnabled: false,
  autoTradeMaxInvestment: 10000000,
  autoTradeMaxPerStock: 2000000,
  autoTradeMaxDailyTrades: 10,

  scheduleKrx: { enabled: false, preOpen: true, postOpen: true, preClose1h: true, preClose30m: true } as Record<string, boolean>,
  scheduleNyse: { enabled: false, preOpen: true, postOpen: true, preClose1h: true, preClose30m: true } as Record<string, boolean>,

  tradingRulesEnabled: true,
  tradingRulesStrictMode: false,
  gapThresholdPercent: 3,
  volumeSurgeRatio: 1.5,
  lowVolumeRatio: 0.7,
  sidewaysAtrPercent: 1.0,

  portfolioMaxHoldings: 10,
  portfolioMaxPerStockPercent: 20,
  portfolioMaxSectorPercent: 40,
  portfolioMinCashPercent: 10,
  portfolioRebalanceEnabled: false,

  // v4.8.0: 매도 규칙
  sellRulesEnabled: true,
  targetProfitRate: 3.0,
  hardStopLossRate: 2.0,
  trailingStopRate: 1.5,
  maxHoldMinutes: 60,

  // v4.8.0: 포지션 사이징
  positionMaxRatio: 25,
  positionMinCashRatio: 20,
  positionMaxPositions: 3,

  // v4.8.0: 동적 스크리닝
  dynamicScreeningEnabled: true,
  screeningVolumeRatioMin: 1.5,
  screeningMinMarketCap: 500,

  // v4.10.0: 가상매매
  paperTradingEnabled: true,
  paperTradeAmount: 1_000_000,

  nasSyncEnabled: false,
  nasSyncPath: '',
  nasSyncTime: '0 20 * * *',
  nasDeviceId: '',
});

const scheduleSlots = [
  { key: 'preOpen', label: '장 시작 전', krxTime: '08:30', nyseTime: '09:00' },
  { key: 'postOpen', label: '장 시작 30분 후', krxTime: '09:30', nyseTime: '10:00' },
  { key: 'preClose1h', label: '장 마감 1시간 전', krxTime: '14:30', nyseTime: '15:00' },
  { key: 'preClose30m', label: '장 마감 30분 전', krxTime: '15:00', nyseTime: '15:30' },
];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);
}

const secretSaved = ref(false);

// MLX (로컬 LLM) 관리
const llmConnected = ref(false);
const llmModels = ref<any[]>([]);
const pullModelName = ref('');
const pulling = ref(false);
const pullStatus = ref('');
const pullProgress = ref(0);
const pullError = ref('');
const pullSuccess = ref('');
const copiedCmd = ref('');

const recommendedModels = [
  { name: 'mlx-community/gemma-3-4b-it-4bit', size: '2.5GB' },
  { name: 'mlx-community/Qwen2.5-7B-Instruct-4bit', size: '4.0GB' },
  { name: 'mlx-community/Llama-3.2-3B-Instruct-4bit', size: '1.8GB' },
  { name: 'mlx-community/gemma-2-2b-it-4bit', size: '1.3GB' },
];

function formatModelSize(bytes: number): string {
  if (!bytes) return '-';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb.toFixed(1) + 'GB';
  return (bytes / (1024 * 1024)).toFixed(0) + 'MB';
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
  copiedCmd.value = text;
  setTimeout(() => { copiedCmd.value = ''; }, 2000);
}

async function checkLlm() {
  try {
    const { data } = await analysisApi.getLlmStatus();
    llmConnected.value = data.connected;
    if (data.connected) await loadLlmModels();
  } catch {
    llmConnected.value = false;
  }
}

async function loadLlmModels() {
  try {
    const { data } = await analysisApi.getLlmModels();
    llmModels.value = (data.models || []).map((m: any) =>
      typeof m === 'string' ? { name: m, size: 0 } : m,
    );
  } catch {
    llmModels.value = [];
  }
}

async function pullModel() {
  if (!pullModelName.value || pulling.value) return;

  pulling.value = true;
  pullStatus.value = '다운로드 준비 중...';
  pullProgress.value = 0;
  pullError.value = '';
  pullSuccess.value = '';

  try {
    const response = await fetch('/api/analysis/llm/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: pullModelName.value }),
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('스트림 읽기 실패');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.error) {
            pullError.value = parsed.error;
          } else if (parsed.status === 'success') {
            pullSuccess.value = `${pullModelName.value} 다운로드 완료`;
            pullStatus.value = '';
            pullProgress.value = 100;
          } else {
            pullStatus.value = parsed.status || '';
            if (parsed.total && parsed.completed) {
              pullProgress.value = Math.round((parsed.completed / parsed.total) * 100);
            }
          }
        } catch { /* skip */ }
      }
    }

    await loadLlmModels();
    if (!pullError.value && !pullSuccess.value) {
      pullSuccess.value = `${pullModelName.value} 다운로드 완료`;
    }
  } catch (err: any) {
    pullError.value = err.message || '다운로드 실패';
  }

  pulling.value = false;
}

async function deleteModel(name: string) {
  if (!confirm(`${name} 모델을 삭제하시겠습니까?`)) return;
  try {
    await analysisApi.deleteLlmModel(name);
    await loadLlmModels();
    if (form.value.mlxModel === name) {
      form.value.mlxModel = llmModels.value[0]?.name || '';
    }
  } catch (err: any) {
    alert(err.response?.data?.error || '삭제 실패');
  }
}

async function validateNasPath() {
  if (!form.value.nasSyncPath) return;
  validating.value = true;
  syncValidateResult.value = '';
  try {
    const { data } = await nasSyncApi.validate(form.value.nasSyncPath);
    syncValidateResult.value = data.valid ? `OK: ${data.message}` : data.message;
  } catch (err: any) {
    syncValidateResult.value = err.response?.data?.message || '경로 확인 실패';
  }
  validating.value = false;
}

async function runSyncNow() {
  syncing.value = true;
  syncResultMessage.value = '';
  syncResultError.value = false;
  try {
    const { data } = await nasSyncApi.run();
    syncResultMessage.value = data.success
      ? `NAS 동기화 완료 — ${data.tablesExported}개 테이블, ${data.totalRecords.toLocaleString()}건 (API 키 마스킹)`
      : data.message;
    syncResultError.value = !data.success;
    await loadSyncStatus();
  } catch (err: any) {
    syncResultMessage.value = err.response?.data?.message || '동기화 실패';
    syncResultError.value = true;
  }
  syncing.value = false;
}

async function runLocalBackup() {
  if (!confirm('로컬 백업은 API 키를 평문으로 포함합니다.\n이 백업 파일은 안전한 개인 저장소(외부 노출 없음)에만 보관하세요.\n\n계속하시겠습니까?')) {
    return;
  }
  syncing.value = true;
  syncResultMessage.value = '';
  syncResultError.value = false;
  try {
    const { data } = await nasSyncApi.backup();
    syncResultMessage.value = data.success
      ? `로컬 백업 완료 — ${data.tablesExported}개 테이블, ${data.totalRecords.toLocaleString()}건 (API 키 포함)`
      : data.message;
    syncResultError.value = !data.success;
    await loadSyncStatus();
  } catch (err: any) {
    syncResultMessage.value = err.response?.data?.message || '백업 실패';
    syncResultError.value = true;
  }
  syncing.value = false;
}

async function loadSyncStatus() {
  try {
    const { data } = await nasSyncApi.getStatus();
    syncStatus.value = data;
  } catch {
    // NAS 동기화 미설정
  }
}

async function loadConfig() {
  try {
    const [statusRes, formRes] = await Promise.all([
      chartApi.getConfig(),
      chartApi.getFormConfig(),
    ]);
    configStatus.value = statusRes.data;

    const saved = formRes.data;
    form.value.appKey = saved.appKey || '';
    form.value.accountNo = saved.accountNo || '';
    form.value.accountProductCode = saved.accountProductCode || '01';
    form.value.isVirtual = saved.isVirtual ?? true;
    secretSaved.value = saved.hasSecret;

    form.value.mlxUrl = saved.mlxUrl || 'http://localhost:8000';
    form.value.mlxModel = saved.mlxModel || 'mlx-community/gemma-3-4b-it-4bit';
    form.value.mlxEnabled = saved.mlxEnabled ?? true;

    form.value.dartEnabled = saved.dartEnabled ?? false;
    dartKeySaved.value = saved.hasDartKey ?? false;

    form.value.investmentStyle = saved.investmentStyle || 'balanced';
    form.value.debateMode = saved.debateMode ?? false;
    form.value.stopLossPercent = saved.stopLossPercent ?? 3;

    form.value.autoTradeEnabled = saved.autoTradeEnabled ?? false;
    form.value.autoTradeMaxInvestment = saved.autoTradeMaxInvestment ?? 10000000;
    form.value.autoTradeMaxPerStock = saved.autoTradeMaxPerStock ?? 2000000;
    form.value.autoTradeMaxDailyTrades = saved.autoTradeMaxDailyTrades ?? 10;

    if (saved.scheduleKrx) form.value.scheduleKrx = saved.scheduleKrx;
    if (saved.scheduleNyse) form.value.scheduleNyse = saved.scheduleNyse;

    form.value.tradingRulesEnabled = saved.tradingRulesEnabled ?? true;
    form.value.tradingRulesStrictMode = saved.tradingRulesStrictMode ?? false;
    form.value.gapThresholdPercent = saved.gapThresholdPercent ?? 3;
    form.value.volumeSurgeRatio = saved.volumeSurgeRatio ?? 1.5;
    form.value.lowVolumeRatio = saved.lowVolumeRatio ?? 0.7;
    form.value.sidewaysAtrPercent = saved.sidewaysAtrPercent ?? 1.0;

    form.value.portfolioMaxHoldings = saved.portfolioMaxHoldings ?? 10;
    form.value.portfolioMaxPerStockPercent = saved.portfolioMaxPerStockPercent ?? 20;
    form.value.portfolioMaxSectorPercent = saved.portfolioMaxSectorPercent ?? 40;
    form.value.portfolioMinCashPercent = saved.portfolioMinCashPercent ?? 10;
    form.value.portfolioRebalanceEnabled = saved.portfolioRebalanceEnabled ?? false;

    // v4.8.0: 매도 규칙
    form.value.sellRulesEnabled = saved.sellRulesEnabled ?? true;
    form.value.targetProfitRate = saved.targetProfitRate ?? 3.0;
    form.value.hardStopLossRate = saved.hardStopLossRate ?? 2.0;
    form.value.trailingStopRate = saved.trailingStopRate ?? 1.5;
    form.value.maxHoldMinutes = saved.maxHoldMinutes ?? 60;

    // v4.8.0: 포지션 사이징
    form.value.positionMaxRatio = saved.positionMaxRatio ?? 25;
    form.value.positionMinCashRatio = saved.positionMinCashRatio ?? 20;
    form.value.positionMaxPositions = saved.positionMaxPositions ?? 3;

    // v4.8.0: 동적 스크리닝
    form.value.dynamicScreeningEnabled = saved.dynamicScreeningEnabled ?? true;
    form.value.screeningVolumeRatioMin = saved.screeningVolumeRatioMin ?? 1.5;
    form.value.screeningMinMarketCap = saved.screeningMinMarketCap ?? 500;

    // v4.10.0: 가상매매
    form.value.paperTradingEnabled = saved.paperTradingEnabled ?? true;
    form.value.paperTradeAmount = saved.paperTradeAmount ?? 1_000_000;

    form.value.nasSyncEnabled = saved.nasSyncEnabled ?? false;
    form.value.nasSyncPath = saved.nasSyncPath || '';
    form.value.nasSyncTime = saved.nasSyncTime || '0 20 * * *';
    form.value.nasDeviceId = saved.nasDeviceId || '';
  } catch {
    // 설정 없음
  }
}

async function saveConfig() {
  saving.value = true;
  saveMessage.value = '';
  saveError.value = false;
  try {
    await chartApi.saveConfig(form.value);
    saveMessage.value = '설정이 저장되었습니다.';
    form.value.appSecret = ''; // 저장 후 Secret 필드 초기화
    await loadConfig();
  } catch (err: any) {
    saveError.value = true;
    saveMessage.value = err.response?.data?.error || '저장 실패';
  } finally {
    saving.value = false;
    setTimeout(() => { saveMessage.value = ''; }, 3000);
  }
}

onMounted(async () => {
  await loadConfig();
  checkLlm();
  loadLoraStatus();
  loadSyncStatus();
});
</script>
