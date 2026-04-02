<template>
  <div class="max-w-2xl">
    <h2 class="text-2xl font-bold text-slate-800 mb-2">설정</h2>
    <p class="text-slate-500 text-sm mb-8">한국투자증권 API 연동 및 앱 설정을 관리합니다.</p>

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
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">API 인증 정보</h3>
          <p class="text-xs text-slate-500 mt-0.5">
            <a href="https://apiportal.koreainvestment.com" target="_blank" class="text-blue-500 hover:underline">KIS Developers 포털</a>에서 앱을 등록하고 발급받은 키를 입력하세요.
          </p>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">
              App Key <span class="text-red-500">*</span>
            </label>
            <input
              v-model="form.appKey"
              type="password"
              placeholder="P-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <p class="text-xs text-slate-400 mt-1">KIS Developers에서 앱 등록 후 발급받은 App Key</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">
              App Secret <span class="text-red-500">*</span>
              <span v-if="secretSaved" class="ml-2 text-xs font-normal text-green-600 bg-green-50 px-1.5 py-0.5 rounded">저장됨</span>
            </label>
            <input
              v-model="form.appSecret"
              type="password"
              :placeholder="secretSaved ? '변경할 경우에만 입력 (비워두면 기존 값 유지)' : 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'"
              class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              :required="!secretSaved"
            />
            <p class="text-xs text-slate-400 mt-1">App Key에 대응하는 App Secret</p>
          </div>
        </div>
      </div>

      <!-- 섹션 2: 계좌 정보 -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">계좌 정보</h3>
          <p class="text-xs text-slate-500 mt-0.5">주문 기능을 사용하려면 계좌번호가 필요합니다. 시세 조회만 사용하는 경우 생략 가능합니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <div class="grid grid-cols-3 gap-4">
            <div class="col-span-2">
              <label class="block text-sm font-medium text-slate-700 mb-1">계좌번호</label>
              <input
                v-model="form.accountNo"
                type="text"
                placeholder="12345678"
                maxlength="8"
                class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p class="text-xs text-slate-400 mt-1">계좌번호 8자리 (숫자만)</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">상품코드</label>
              <input
                v-model="form.accountProductCode"
                type="text"
                placeholder="01"
                maxlength="2"
                class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p class="text-xs text-slate-400 mt-1">보통 01</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 3: 거래 환경 -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">거래 환경</h3>
        </div>
        <div class="p-6">
          <div class="flex gap-3">
            <button
              type="button"
              @click="form.isVirtual = true"
              class="flex-1 py-3 px-4 rounded-xl border-2 text-sm font-medium transition-all"
              :class="form.isVirtual ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'"
            >
              <div class="text-lg mb-1">🧪</div>
              <div class="font-semibold">모의투자</div>
              <div class="text-xs mt-0.5 opacity-70">가상 자금으로 테스트</div>
            </button>
            <button
              type="button"
              @click="form.isVirtual = false"
              class="flex-1 py-3 px-4 rounded-xl border-2 text-sm font-medium transition-all"
              :class="!form.isVirtual ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'"
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

      <!-- 섹션 4: Ollama (로컬 LLM) -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">Ollama (로컬 LLM)</h3>
          <p class="text-xs text-slate-500 mt-0.5">매수/매도 판단에 사용할 로컬 LLM을 설정합니다.</p>
        </div>
        <div class="p-6 space-y-4">

          <!-- Ollama 연결 상태 -->
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="relative">
                <input type="checkbox" v-model="form.ollamaEnabled" class="sr-only" />
                <div class="w-11 h-6 rounded-full transition-colors" :class="form.ollamaEnabled ? 'bg-blue-600' : 'bg-slate-200'"></div>
                <div class="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.ollamaEnabled ? 'translate-x-5' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm font-medium text-slate-700">Ollama 활성화</span>
            </label>
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
              :class="ollamaConnected ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'">
              <span class="w-1.5 h-1.5 rounded-full" :class="ollamaConnected ? 'bg-green-500' : 'bg-slate-400'"></span>
              {{ ollamaConnected ? '연결됨' : '미연결' }}
            </span>
          </div>

          <!-- 설치 안내 (미연결 시) -->
          <div v-if="!ollamaConnected" class="p-4 bg-amber-50 rounded-lg border border-amber-200">
            <p class="text-sm font-medium text-amber-800 mb-2">Ollama가 설치되지 않았거나 실행 중이 아닙니다</p>
            <div class="space-y-2">
              <div>
                <p class="text-xs text-amber-700 mb-1">1. Homebrew로 설치 (Mac):</p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 bg-white px-3 py-1.5 rounded border border-amber-200 text-xs font-mono text-slate-700">brew install ollama</code>
                  <button type="button" @click="copyToClipboard('brew install ollama')"
                    class="px-2 py-1.5 bg-amber-100 text-amber-700 rounded text-xs hover:bg-amber-200 transition whitespace-nowrap">
                    {{ copiedCmd === 'brew install ollama' ? '복사됨' : '복사' }}
                  </button>
                </div>
              </div>
              <div>
                <p class="text-xs text-amber-700 mb-1">2. Ollama 서버 실행:</p>
                <div class="flex items-center gap-2">
                  <code class="flex-1 bg-white px-3 py-1.5 rounded border border-amber-200 text-xs font-mono text-slate-700">ollama serve</code>
                  <button type="button" @click="copyToClipboard('ollama serve')"
                    class="px-2 py-1.5 bg-amber-100 text-amber-700 rounded text-xs hover:bg-amber-200 transition whitespace-nowrap">
                    {{ copiedCmd === 'ollama serve' ? '복사됨' : '복사' }}
                  </button>
                </div>
              </div>
              <div>
                <p class="text-xs text-amber-700 mb-1">3. 또는 공식 앱 다운로드:</p>
                <a href="https://ollama.com/download" target="_blank"
                  class="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                  ollama.com/download
                </a>
              </div>
              <button type="button" @click="checkOllama"
                class="mt-1 px-3 py-1.5 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 transition">
                연결 재확인
              </button>
            </div>
          </div>

          <!-- Ollama URL / 모델 설정 -->
          <div v-if="form.ollamaEnabled" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Ollama URL</label>
              <input v-model="form.ollamaUrl" type="text" placeholder="http://localhost:11434"
                class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">사용 모델</label>
              <div class="flex gap-2">
                <select v-if="ollamaModels.length > 0" v-model="form.ollamaModel"
                  class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option v-for="m in ollamaModels" :key="m.name" :value="m.name">
                    {{ m.name }} ({{ formatModelSize(m.size) }})
                  </option>
                </select>
                <input v-else v-model="form.ollamaModel" type="text" placeholder="llama3.1"
                  class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <button type="button" @click="loadOllamaModels"
                  class="px-3 py-2 border border-slate-300 rounded-lg text-xs text-slate-600 hover:bg-slate-50 transition whitespace-nowrap">
                  새로고침
                </button>
              </div>
            </div>
          </div>

          <!-- 모델 관리 (연결 시) -->
          <div v-if="ollamaConnected" class="border-t border-slate-100 pt-4 space-y-3">
            <div class="flex items-center justify-between">
              <h4 class="text-sm font-medium text-slate-700">설치된 모델</h4>
              <button type="button" @click="loadOllamaModels" class="text-xs text-blue-600 hover:underline">새로고침</button>
            </div>

            <!-- 모델 목록 -->
            <div v-if="ollamaModels.length === 0" class="text-sm text-slate-400 py-2">설치된 모델이 없습니다. 아래에서 다운로드하세요.</div>
            <div v-else class="space-y-1">
              <div v-for="m in ollamaModels" :key="m.name"
                class="flex items-center justify-between px-3 py-2 rounded-lg"
                :class="form.ollamaModel === m.name ? 'bg-blue-50 border border-blue-200' : 'bg-slate-50'">
                <div class="flex items-center gap-2">
                  <span v-if="form.ollamaModel === m.name" class="text-xs text-blue-600 font-medium">사용 중</span>
                  <span class="text-sm font-mono text-slate-700">{{ m.name }}</span>
                  <span class="text-xs text-slate-400">{{ formatModelSize(m.size) }}</span>
                </div>
                <div class="flex gap-2">
                  <button v-if="form.ollamaModel !== m.name" type="button" @click="form.ollamaModel = m.name"
                    class="text-xs text-blue-600 hover:underline">선택</button>
                  <button type="button" @click="deleteModel(m.name)"
                    class="text-xs text-red-500 hover:underline">삭제</button>
                </div>
              </div>
            </div>

            <!-- 모델 다운로드 -->
            <div class="bg-slate-50 rounded-lg p-4 space-y-3">
              <h4 class="text-sm font-medium text-slate-700">모델 다운로드</h4>
              <div class="flex gap-2 flex-wrap">
                <button type="button" v-for="rec in recommendedModels" :key="rec.name"
                  @click="pullModelName = rec.name"
                  class="px-3 py-1.5 rounded-lg text-xs font-medium border transition"
                  :class="pullModelName === rec.name ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'">
                  {{ rec.name }} <span class="text-slate-400 font-normal">({{ rec.size }})</span>
                </button>
              </div>
              <div class="flex gap-2">
                <input v-model="pullModelName" type="text" placeholder="모델명 (예: llama3.1, qwen3:4b)"
                  class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <button type="button" @click="pullModel" :disabled="pulling || !pullModelName"
                  class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition whitespace-nowrap">
                  {{ pulling ? '다운로드 중...' : '다운로드' }}
                </button>
              </div>

              <!-- 다운로드 진행 상태 -->
              <div v-if="pullStatus" class="space-y-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-slate-600">{{ pullStatus }}</span>
                  <span v-if="pullProgress > 0" class="text-slate-500">{{ pullProgress }}%</span>
                </div>
                <div v-if="pullProgress > 0" class="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div class="h-full bg-blue-600 rounded-full transition-all" :style="{ width: pullProgress + '%' }"></div>
                </div>
              </div>
              <div v-if="pullError" class="text-xs text-red-600">{{ pullError }}</div>
              <div v-if="pullSuccess" class="text-xs text-green-600">{{ pullSuccess }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 5: AI 분석 옵션 -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">AI 분석 옵션</h3>
          <p class="text-xs text-slate-500 mt-0.5">LLM 매매 판단의 투자 스타일과 분석 방식을 설정합니다.</p>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-2">투자 스타일</label>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
              <button type="button" v-for="opt in [
                { v: 'balanced', l: '균형형', d: 'RSI·MACD 등 종합 판단' },
                { v: 'value', l: '가치투자', d: '저PER·저PBR 안전마진 중시' },
                { v: 'growth', l: '성장투자', d: '매출 성장·혁신 기업 선호' },
                { v: 'momentum', l: '모멘텀', d: '추세 추종·돌파 패턴 중심' },
              ]" :key="opt.v" @click="form.investmentStyle = opt.v"
                class="py-2.5 px-3 rounded-lg border-2 text-center transition-all"
                :class="form.investmentStyle === opt.v ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-slate-300'">
                <div class="text-sm font-medium" :class="form.investmentStyle === opt.v ? 'text-blue-700' : 'text-slate-700'">{{ opt.l }}</div>
                <div class="text-xs mt-0.5" :class="form.investmentStyle === opt.v ? 'text-blue-500' : 'text-slate-400'">{{ opt.d }}</div>
              </button>
            </div>
          </div>
          <div>
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="relative inline-block">
                <input type="checkbox" v-model="form.debateMode" class="sr-only" />
                <div class="w-9 h-5 rounded-full transition-colors" :class="form.debateMode ? 'bg-blue-600' : 'bg-slate-200'"></div>
                <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.debateMode ? 'translate-x-4' : 'translate-x-0'"></div>
              </div>
              <span class="text-sm font-medium text-slate-700">토론 모드 (강세/약세 분석)</span>
            </label>
            <p class="text-xs text-slate-500 mt-1 ml-12">LLM이 강세·약세 관점을 각각 분석한 뒤 종합 판단합니다. 정확도가 높아지지만 분석 시간이 3배로 늘어납니다.</p>
          </div>
        </div>
      </div>

      <!-- 섹션 6: 자동매매 설정 -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">자동매매</h3>
          <p class="text-xs text-slate-500 mt-0.5">자동매매 활성화 및 리스크 관리 설정</p>
        </div>
        <div class="p-6 space-y-4">
          <label class="flex items-center gap-3 cursor-pointer">
            <div class="relative">
              <input type="checkbox" v-model="form.autoTradeEnabled" class="sr-only" />
              <div class="w-11 h-6 rounded-full transition-colors" :class="form.autoTradeEnabled ? 'bg-blue-600' : 'bg-slate-200'"></div>
              <div class="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.autoTradeEnabled ? 'translate-x-5' : 'translate-x-0'"></div>
            </div>
            <span class="text-sm font-medium text-slate-700">자동매매 활성화</span>
          </label>
          <div v-if="!form.autoTradeEnabled" class="p-3 bg-slate-50 rounded-lg border border-slate-200">
            <p class="text-xs text-slate-500">자동매매가 비활성화되어 있습니다. 매매 신호는 생성되지만 주문은 실행되지 않습니다.</p>
          </div>
          <div v-if="form.autoTradeEnabled" class="p-3 bg-red-50 rounded-lg border border-red-200">
            <p class="text-xs text-red-600">⚠️ 자동매매가 활성화되면 LLM 판단에 따라 실제 주문이 실행됩니다.</p>
          </div>
          <div class="grid grid-cols-3 gap-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">총 최대 투자금액</label>
              <input v-model.number="form.autoTradeMaxInvestment" type="number" min="0" step="1000000"
                class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p class="text-xs text-slate-400 mt-1">{{ formatCurrency(form.autoTradeMaxInvestment) }}</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">종목당 최대</label>
              <input v-model.number="form.autoTradeMaxPerStock" type="number" min="0" step="500000"
                class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p class="text-xs text-slate-400 mt-1">{{ formatCurrency(form.autoTradeMaxPerStock) }}</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">일일 최대 거래</label>
              <input v-model.number="form.autoTradeMaxDailyTrades" type="number" min="1" max="100"
                class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p class="text-xs text-slate-400 mt-1">{{ form.autoTradeMaxDailyTrades }}회</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 섹션 7: 스케줄 설정 -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 bg-slate-50 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-700">매매 스케줄</h3>
          <p class="text-xs text-slate-500 mt-0.5">시장별 자동 분석/매매 스케줄 (주말 제외)</p>
        </div>
        <div class="p-6 space-y-6">
          <!-- KRX -->
          <div>
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold text-slate-700">🇰🇷 KRX (한국거래소)</span>
                <span class="text-xs text-slate-400">09:00 ~ 15:30 KST</span>
              </div>
              <label class="flex items-center gap-2 cursor-pointer">
                <div class="relative">
                  <input type="checkbox" v-model="form.scheduleKrx.enabled" class="sr-only" />
                  <div class="w-9 h-5 rounded-full transition-colors" :class="form.scheduleKrx.enabled ? 'bg-blue-600' : 'bg-slate-200'"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.scheduleKrx.enabled ? 'translate-x-4' : 'translate-x-0'"></div>
                </div>
              </label>
            </div>
            <div v-if="form.scheduleKrx.enabled" class="grid grid-cols-2 gap-2">
              <label v-for="s in scheduleSlots" :key="'krx-'+s.key"
                class="flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer"
                :class="form.scheduleKrx[s.key] ? 'border-blue-200 bg-blue-50' : 'border-slate-200'">
                <input type="checkbox" v-model="form.scheduleKrx[s.key]" class="rounded text-blue-600" />
                <div>
                  <span class="font-medium text-slate-700">{{ s.label }}</span>
                  <span class="text-slate-400 ml-1">{{ s.krxTime }}</span>
                </div>
              </label>
            </div>
          </div>
          <!-- NYSE -->
          <div class="border-t border-slate-100 pt-6">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold text-slate-700">🇺🇸 NYSE/NASDAQ</span>
                <span class="text-xs text-slate-400">09:30 ~ 16:00 ET</span>
              </div>
              <label class="flex items-center gap-2 cursor-pointer">
                <div class="relative">
                  <input type="checkbox" v-model="form.scheduleNyse.enabled" class="sr-only" />
                  <div class="w-9 h-5 rounded-full transition-colors" :class="form.scheduleNyse.enabled ? 'bg-blue-600' : 'bg-slate-200'"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="form.scheduleNyse.enabled ? 'translate-x-4' : 'translate-x-0'"></div>
                </div>
              </label>
            </div>
            <div v-if="form.scheduleNyse.enabled" class="grid grid-cols-2 gap-2">
              <label v-for="s in scheduleSlots" :key="'nyse-'+s.key"
                class="flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer"
                :class="form.scheduleNyse[s.key] ? 'border-blue-200 bg-blue-50' : 'border-slate-200'">
                <input type="checkbox" v-model="form.scheduleNyse[s.key]" class="rounded text-blue-600" />
                <div>
                  <span class="font-medium text-slate-700">{{ s.label }}</span>
                  <span class="text-slate-400 ml-1">{{ s.nyseTime }}</span>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- 저장 버튼 -->
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="saving"
          class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {{ saving ? '저장 중...' : '설정 저장' }}
        </button>
        <span v-if="saveMessage" class="text-sm" :class="saveError ? 'text-red-500' : 'text-green-600'">
          {{ saveMessage }}
        </span>
      </div>
    </form>

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
import { ref, computed, onMounted } from 'vue';
import { chartApi, analysisApi } from '@/api';

const configStatus = ref({ configured: false, isVirtual: true, hasAccount: false });
const saving = ref(false);
const saveMessage = ref('');
const saveError = ref(false);

const form = ref({
  appKey: '',
  appSecret: '',
  accountNo: '',
  accountProductCode: '01',
  isVirtual: true,

  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1',
  ollamaEnabled: false,

  investmentStyle: 'balanced',
  debateMode: false,

  autoTradeEnabled: false,
  autoTradeMaxInvestment: 10000000,
  autoTradeMaxPerStock: 2000000,
  autoTradeMaxDailyTrades: 10,

  scheduleKrx: { enabled: false, preOpen: true, postOpen: true, preClose1h: true, preClose30m: true } as Record<string, boolean>,
  scheduleNyse: { enabled: false, preOpen: true, postOpen: true, preClose1h: true, preClose30m: true } as Record<string, boolean>,
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

// Ollama 관리
const ollamaConnected = ref(false);
const ollamaModels = ref<any[]>([]);
const pullModelName = ref('');
const pulling = ref(false);
const pullStatus = ref('');
const pullProgress = ref(0);
const pullError = ref('');
const pullSuccess = ref('');
const copiedCmd = ref('');

const recommendedModels = [
  { name: 'qwen3:4b', size: '2.6GB' },
  { name: 'llama3.1:8b', size: '4.7GB' },
  { name: 'gemma3:4b', size: '3.3GB' },
  { name: 'deepseek-r1:7b', size: '4.7GB' },
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

async function checkOllama() {
  try {
    const { data } = await analysisApi.getOllamaStatus();
    ollamaConnected.value = data.connected;
    if (data.connected) await loadOllamaModels();
  } catch {
    ollamaConnected.value = false;
  }
}

async function loadOllamaModels() {
  try {
    const { data } = await analysisApi.getOllamaModels();
    ollamaModels.value = data.models || [];
  } catch {
    ollamaModels.value = [];
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
    const response = await fetch('/api/analysis/ollama/pull', {
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

    await loadOllamaModels();
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
    await analysisApi.deleteOllamaModel(name);
    await loadOllamaModels();
    if (form.value.ollamaModel === name) {
      form.value.ollamaModel = ollamaModels.value[0]?.name || '';
    }
  } catch (err: any) {
    alert(err.response?.data?.error || '삭제 실패');
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

    form.value.ollamaUrl = saved.ollamaUrl || 'http://localhost:11434';
    form.value.ollamaModel = saved.ollamaModel || 'llama3.1';
    form.value.ollamaEnabled = saved.ollamaEnabled ?? false;

    form.value.investmentStyle = saved.investmentStyle || 'balanced';
    form.value.debateMode = saved.debateMode ?? false;

    form.value.autoTradeEnabled = saved.autoTradeEnabled ?? false;
    form.value.autoTradeMaxInvestment = saved.autoTradeMaxInvestment ?? 10000000;
    form.value.autoTradeMaxPerStock = saved.autoTradeMaxPerStock ?? 2000000;
    form.value.autoTradeMaxDailyTrades = saved.autoTradeMaxDailyTrades ?? 10;

    if (saved.scheduleKrx) form.value.scheduleKrx = saved.scheduleKrx;
    if (saved.scheduleNyse) form.value.scheduleNyse = saved.scheduleNyse;
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
  checkOllama();
});
</script>
