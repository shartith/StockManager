/**
 * Curated stock lists for market heatmap.
 * Yahoo Finance ticker format: KOSPI = "005930.KS", KOSDAQ = "373220.KQ"
 */

export interface MarketStock {
  ticker: string;
  yahooTicker: string;
  name: string;
  sector: string;
}

// ── KRX Top Stocks (~80) ──

export const KRX_TOP_STOCKS: readonly MarketStock[] = [
  // AI/반도체
  { ticker: '005930', yahooTicker: '005930.KS', name: '삼성전자', sector: 'AI/반도체' },
  { ticker: '000660', yahooTicker: '000660.KS', name: 'SK하이닉스', sector: 'AI/반도체' },
  { ticker: '402340', yahooTicker: '402340.KQ', name: 'SK스퀘어', sector: 'AI/반도체' },
  { ticker: '042700', yahooTicker: '042700.KQ', name: '한미반도체', sector: 'AI/반도체' },
  { ticker: '000990', yahooTicker: '000990.KS', name: 'DB하이텍', sector: 'AI/반도체' },
  { ticker: '058470', yahooTicker: '058470.KQ', name: '리노공업', sector: 'AI/반도체' },
  { ticker: '403870', yahooTicker: '403870.KQ', name: 'HPSP', sector: 'AI/반도체' },

  // 금융
  { ticker: '105560', yahooTicker: '105560.KS', name: 'KB금융', sector: '금융' },
  { ticker: '055550', yahooTicker: '055550.KS', name: '신한지주', sector: '금융' },
  { ticker: '086790', yahooTicker: '086790.KS', name: '하나금융지주', sector: '금융' },
  { ticker: '316140', yahooTicker: '316140.KS', name: '우리금융지주', sector: '금융' },
  { ticker: '024110', yahooTicker: '024110.KS', name: '기업은행', sector: '금융' },
  { ticker: '138930', yahooTicker: '138930.KS', name: 'BNK금융지주', sector: '금융' },
  { ticker: '005830', yahooTicker: '005830.KS', name: 'DB손해보험', sector: '금융' },
  { ticker: '032830', yahooTicker: '032830.KS', name: '삼성생명', sector: '금융' },
  { ticker: '030200', yahooTicker: '030200.KS', name: 'KT', sector: '유틸리티' },

  // 자동차
  { ticker: '005380', yahooTicker: '005380.KS', name: '현대차', sector: '자동차' },
  { ticker: '000270', yahooTicker: '000270.KS', name: '기아', sector: '자동차' },
  { ticker: '012330', yahooTicker: '012330.KS', name: '현대모비스', sector: '자동차' },
  { ticker: '018880', yahooTicker: '018880.KS', name: '한온시스템', sector: '자동차' },

  // 2차전지/에너지
  { ticker: '373220', yahooTicker: '373220.KS', name: 'LG에너지솔루션', sector: '2차전지/에너지' },
  { ticker: '006400', yahooTicker: '006400.KS', name: '삼성SDI', sector: '2차전지/에너지' },
  { ticker: '051910', yahooTicker: '051910.KS', name: 'LG화학', sector: '2차전지/에너지' },
  { ticker: '247540', yahooTicker: '247540.KS', name: '에코프로비엠', sector: '2차전지/에너지' },
  { ticker: '086520', yahooTicker: '086520.KS', name: '에코프로', sector: '2차전지/에너지' },
  { ticker: '112610', yahooTicker: '112610.KQ', name: '씨에스윈드', sector: '2차전지/에너지' },

  // 바이오/헬스
  { ticker: '068270', yahooTicker: '068270.KS', name: '셀트리온', sector: '바이오/헬스' },
  { ticker: '207940', yahooTicker: '207940.KS', name: '삼성바이오로직스', sector: '바이오/헬스' },
  { ticker: '326030', yahooTicker: '326030.KQ', name: 'SK바이오팜', sector: '바이오/헬스' },
  { ticker: '128940', yahooTicker: '128940.KS', name: '한미약품', sector: '바이오/헬스' },
  { ticker: '000100', yahooTicker: '000100.KS', name: '유한양행', sector: '바이오/헬스' },

  // IT/플랫폼
  { ticker: '035420', yahooTicker: '035420.KS', name: 'NAVER', sector: 'IT/플랫폼' },
  { ticker: '035720', yahooTicker: '035720.KS', name: '카카오', sector: 'IT/플랫폼' },
  { ticker: '036570', yahooTicker: '036570.KQ', name: '엔씨소프트', sector: 'IT/플랫폼' },
  { ticker: '263750', yahooTicker: '263750.KQ', name: '펄어비스', sector: 'IT/플랫폼' },
  { ticker: '259960', yahooTicker: '259960.KQ', name: '크래프톤', sector: 'IT/플랫폼' },

  // 산업재/조선/건설
  { ticker: '329180', yahooTicker: '329180.KS', name: 'HD현대중공업', sector: '산업재' },
  { ticker: '009540', yahooTicker: '009540.KS', name: 'HD한국조선해양', sector: '산업재' },
  { ticker: '042660', yahooTicker: '042660.KS', name: '한화오션', sector: '산업재' },
  { ticker: '034020', yahooTicker: '034020.KS', name: '두산에너빌리티', sector: '산업재' },
  { ticker: '000720', yahooTicker: '000720.KS', name: '현대건설', sector: '산업재' },
  { ticker: '010130', yahooTicker: '010130.KS', name: '고려아연', sector: '산업재' },
  { ticker: '047050', yahooTicker: '047050.KS', name: '포스코인터내셔널', sector: '산업재' },

  // 항공우주/방위
  { ticker: '012450', yahooTicker: '012450.KS', name: '한화에어로스페이스', sector: '항공우주/방위' },
  { ticker: '047810', yahooTicker: '047810.KS', name: '한국항공우주', sector: '항공우주/방위' },
  { ticker: '272210', yahooTicker: '272210.KS', name: '한화시스템', sector: '항공우주/방위' },
  { ticker: '082740', yahooTicker: '082740.KQ', name: 'HSD엔진', sector: '항공우주/방위' },
  { ticker: '064350', yahooTicker: '064350.KS', name: '현대로템', sector: '항공우주/방위' },
  { ticker: '079550', yahooTicker: '079550.KS', name: 'LIG넥스원', sector: '항공우주/방위' },

  // 소비재/유통
  { ticker: '051900', yahooTicker: '051900.KS', name: 'LG생활건강', sector: '소비재' },
  { ticker: '090430', yahooTicker: '090430.KS', name: '아모레퍼시픽', sector: '소비재' },
  { ticker: '004170', yahooTicker: '004170.KS', name: '신세계', sector: '소비재' },
  { ticker: '069960', yahooTicker: '069960.KQ', name: '현대백화점', sector: '소비재' },

  // 철강/화학
  { ticker: '005490', yahooTicker: '005490.KS', name: 'POSCO홀딩스', sector: '소재' },
  { ticker: '010950', yahooTicker: '010950.KS', name: 'S-Oil', sector: '소재' },
  { ticker: '011170', yahooTicker: '011170.KS', name: '롯데케미칼', sector: '소재' },
  { ticker: '003670', yahooTicker: '003670.KS', name: '포스코퓨처엠', sector: '소재' },

  // 통신/유틸리티
  { ticker: '017670', yahooTicker: '017670.KS', name: 'SK텔레콤', sector: '유틸리티' },
  { ticker: '032640', yahooTicker: '032640.KS', name: 'LG유플러스', sector: '유틸리티' },
  { ticker: '015760', yahooTicker: '015760.KS', name: '한국전력', sector: '유틸리티' },

  // 엔터/미디어
  { ticker: '352820', yahooTicker: '352820.KS', name: '하이브', sector: '엔터/미디어' },
  { ticker: '041510', yahooTicker: '041510.KQ', name: 'SM', sector: '엔터/미디어' },
  { ticker: '122870', yahooTicker: '122870.KS', name: 'YG엔터', sector: '엔터/미디어' },

  // 해운/물류
  { ticker: '011200', yahooTicker: '011200.KS', name: 'HMM', sector: '산업재' },
  { ticker: '028670', yahooTicker: '028670.KQ', name: '팬오션', sector: '산업재' },

  // 전기장비
  { ticker: '267260', yahooTicker: '267260.KS', name: 'HD현대일렉트릭', sector: '산업재' },
  { ticker: '003230', yahooTicker: '003230.KS', name: '삼양식품', sector: '소비재' },
  { ticker: '034730', yahooTicker: '034730.KS', name: 'SK', sector: 'IT/플랫폼' },
  { ticker: '066570', yahooTicker: '066570.KS', name: 'LG전자', sector: 'AI/반도체' },
  { ticker: '003550', yahooTicker: '003550.KS', name: 'LG', sector: 'IT/플랫폼' },
  { ticker: '036460', yahooTicker: '036460.KS', name: '한국가스공사', sector: '유틸리티' },
  { ticker: '180640', yahooTicker: '180640.KS', name: '한진칼', sector: '산업재' },
  { ticker: '028260', yahooTicker: '028260.KS', name: '삼성물산', sector: '산업재' },
  { ticker: '009150', yahooTicker: '009150.KS', name: '삼성전기', sector: 'AI/반도체' },
  { ticker: '006800', yahooTicker: '006800.KS', name: '미래에셋증권', sector: '금융' },
  { ticker: '000810', yahooTicker: '000810.KS', name: '삼성화재', sector: '금융' },
] as const;

// ── S&P 500 Sector ETFs (11) + Top Individual Stocks ──

export const US_SECTOR_ETFS: readonly MarketStock[] = [
  { ticker: 'XLK', yahooTicker: 'XLK', name: 'Technology', sector: 'Technology' },
  { ticker: 'XLF', yahooTicker: 'XLF', name: 'Financials', sector: 'Financials' },
  { ticker: 'XLV', yahooTicker: 'XLV', name: 'Healthcare', sector: 'Healthcare' },
  { ticker: 'XLY', yahooTicker: 'XLY', name: 'Consumer Disc.', sector: 'Consumer Discretionary' },
  { ticker: 'XLP', yahooTicker: 'XLP', name: 'Consumer Staples', sector: 'Consumer Staples' },
  { ticker: 'XLE', yahooTicker: 'XLE', name: 'Energy', sector: 'Energy' },
  { ticker: 'XLI', yahooTicker: 'XLI', name: 'Industrials', sector: 'Industrials' },
  { ticker: 'XLB', yahooTicker: 'XLB', name: 'Materials', sector: 'Materials' },
  { ticker: 'XLRE', yahooTicker: 'XLRE', name: 'Real Estate', sector: 'Real Estate' },
  { ticker: 'XLC', yahooTicker: 'XLC', name: 'Communication', sector: 'Communication' },
  { ticker: 'XLU', yahooTicker: 'XLU', name: 'Utilities', sector: 'Utilities' },
] as const;

export const US_TOP_STOCKS: readonly MarketStock[] = [
  // Technology
  { ticker: 'AAPL', yahooTicker: 'AAPL', name: 'Apple', sector: 'Technology' },
  { ticker: 'MSFT', yahooTicker: 'MSFT', name: 'Microsoft', sector: 'Technology' },
  { ticker: 'NVDA', yahooTicker: 'NVDA', name: 'NVIDIA', sector: 'Technology' },
  { ticker: 'AVGO', yahooTicker: 'AVGO', name: 'Broadcom', sector: 'Technology' },
  { ticker: 'ORCL', yahooTicker: 'ORCL', name: 'Oracle', sector: 'Technology' },

  // Communication
  { ticker: 'GOOG', yahooTicker: 'GOOG', name: 'Alphabet', sector: 'Communication' },
  { ticker: 'META', yahooTicker: 'META', name: 'Meta', sector: 'Communication' },
  { ticker: 'NFLX', yahooTicker: 'NFLX', name: 'Netflix', sector: 'Communication' },

  // Consumer Discretionary
  { ticker: 'AMZN', yahooTicker: 'AMZN', name: 'Amazon', sector: 'Consumer Discretionary' },
  { ticker: 'TSLA', yahooTicker: 'TSLA', name: 'Tesla', sector: 'Consumer Discretionary' },
  { ticker: 'HD', yahooTicker: 'HD', name: 'Home Depot', sector: 'Consumer Discretionary' },

  // Financials
  { ticker: 'BRK-B', yahooTicker: 'BRK-B', name: 'Berkshire', sector: 'Financials' },
  { ticker: 'JPM', yahooTicker: 'JPM', name: 'JPMorgan', sector: 'Financials' },
  { ticker: 'V', yahooTicker: 'V', name: 'Visa', sector: 'Financials' },
  { ticker: 'MA', yahooTicker: 'MA', name: 'Mastercard', sector: 'Financials' },

  // Healthcare
  { ticker: 'UNH', yahooTicker: 'UNH', name: 'UnitedHealth', sector: 'Healthcare' },
  { ticker: 'LLY', yahooTicker: 'LLY', name: 'Eli Lilly', sector: 'Healthcare' },
  { ticker: 'JNJ', yahooTicker: 'JNJ', name: 'J&J', sector: 'Healthcare' },
  { ticker: 'ABBV', yahooTicker: 'ABBV', name: 'AbbVie', sector: 'Healthcare' },

  // Energy
  { ticker: 'XOM', yahooTicker: 'XOM', name: 'ExxonMobil', sector: 'Energy' },
  { ticker: 'CVX', yahooTicker: 'CVX', name: 'Chevron', sector: 'Energy' },

  // Industrials
  { ticker: 'GE', yahooTicker: 'GE', name: 'GE Aerospace', sector: 'Industrials' },
  { ticker: 'CAT', yahooTicker: 'CAT', name: 'Caterpillar', sector: 'Industrials' },
  { ticker: 'RTX', yahooTicker: 'RTX', name: 'RTX Corp', sector: 'Industrials' },

  // Consumer Staples
  { ticker: 'PG', yahooTicker: 'PG', name: 'Procter & Gamble', sector: 'Consumer Staples' },
  { ticker: 'KO', yahooTicker: 'KO', name: 'Coca-Cola', sector: 'Consumer Staples' },
  { ticker: 'COST', yahooTicker: 'COST', name: 'Costco', sector: 'Consumer Staples' },

  // Materials
  { ticker: 'LIN', yahooTicker: 'LIN', name: 'Linde', sector: 'Materials' },
  { ticker: 'APD', yahooTicker: 'APD', name: 'Air Products', sector: 'Materials' },

  // Real Estate
  { ticker: 'PLD', yahooTicker: 'PLD', name: 'Prologis', sector: 'Real Estate' },
  { ticker: 'AMT', yahooTicker: 'AMT', name: 'American Tower', sector: 'Real Estate' },

  // Utilities
  { ticker: 'NEE', yahooTicker: 'NEE', name: 'NextEra Energy', sector: 'Utilities' },
  { ticker: 'DUK', yahooTicker: 'DUK', name: 'Duke Energy', sector: 'Utilities' },
] as const;

/** Get all sectors for a market */
export function getSectors(market: 'KRX' | 'US'): string[] {
  const stocks = market === 'KRX' ? KRX_TOP_STOCKS : [...US_SECTOR_ETFS, ...US_TOP_STOCKS];
  return [...new Set(stocks.map(s => s.sector))];
}
