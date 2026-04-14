import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings, saveSettings } from '../services/settings';
import { startScheduler } from '../services/scheduler';
import { queryOne, queryAll, execute, logAudit } from '../db';
import { getMarketContext } from '../services/stockPrice';
import { getDomesticOrderableAmount } from '../services/kisOrder';
import { getQuoteBook, type Market } from '../services/quoteBook';
import {
  reconcileMarket,
  type KisHoldingSnapshot,
  type SmHoldingRow,
  type SyncResult,
  type ReconcileDeps,
} from '../services/portfolioReconcile';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { saveConfigSchema } from '../schemas';

const router = Router();

// KIS API 설정 상태 조회 (마스킹)
router.get('/config', (_req: Request, res: Response) => {
  const settings = getSettings();
  res.json({
    configured: !!(settings.kisAppKey && settings.kisAppSecret),
    isVirtual: settings.kisVirtual,
    hasAccount: !!(settings.kisAccountNo),
    appKey: settings.kisAppKey ? settings.kisAppKey.slice(0, 4) + '****' : '',
    accountNo: settings.kisAccountNo ? settings.kisAccountNo.slice(0, 4) + '****' : '',
    mcpEnabled: settings.mcpEnabled,
  });
});

// 설정 폼 복원용 조회 (AppSecret, AI API Key 제외)
router.get('/config/form', (_req: Request, res: Response) => {
  const settings = getSettings();
  res.json({
    appKey: settings.kisAppKey,
    accountNo: settings.kisAccountNo,
    accountProductCode: settings.kisAccountProductCode,
    isVirtual: settings.kisVirtual,
    mcpEnabled: settings.mcpEnabled,
    hasSecret: !!settings.kisAppSecret,

    ollamaUrl: settings.ollamaUrl,
    ollamaModel: settings.ollamaModel,
    ollamaEnabled: settings.ollamaEnabled,

    dartEnabled: settings.dartEnabled,
    hasDartKey: !!settings.dartApiKey,

    investmentStyle: settings.investmentStyle,
    debateMode: settings.debateMode,
    stopLossPercent: settings.stopLossPercent,

    autoTradeEnabled: settings.autoTradeEnabled,
    autoTradeMaxInvestment: settings.autoTradeMaxInvestment,
    autoTradeMaxPerStock: settings.autoTradeMaxPerStock,
    autoTradeMaxDailyTrades: settings.autoTradeMaxDailyTrades,
    autoTradeScoreThreshold: settings.autoTradeScoreThreshold,
    priceChangeThreshold: settings.priceChangeThreshold,

    scheduleKrx: settings.scheduleKrx,
    scheduleNyse: settings.scheduleNyse,

    nasSyncEnabled: settings.nasSyncEnabled,
    nasSyncPath: settings.nasSyncPath,
    nasSyncTime: settings.nasSyncTime,
    deviceId: settings.deviceId,
    nasHost: settings.nasHost,
    nasShare: settings.nasShare,
    nasUsername: settings.nasUsername,
    hasNasPassword: !!settings.nasPassword,
    nasAutoMount: settings.nasAutoMount,

    portfolioMaxHoldings: settings.portfolioMaxHoldings,
    portfolioMaxPerStockPercent: settings.portfolioMaxPerStockPercent,
    portfolioMaxSectorPercent: settings.portfolioMaxSectorPercent,
    portfolioRebalanceEnabled: settings.portfolioRebalanceEnabled,
    portfolioMinCashPercent: settings.portfolioMinCashPercent,

    tradingRulesEnabled: settings.tradingRulesEnabled,
    tradingRulesStrictMode: settings.tradingRulesStrictMode,
    gapThresholdPercent: settings.gapThresholdPercent,
    volumeSurgeRatio: settings.volumeSurgeRatio,
    lowVolumeRatio: settings.lowVolumeRatio,
    sidewaysAtrPercent: settings.sidewaysAtrPercent,

    // v4.8.0: 매도 규칙
    sellRulesEnabled: settings.sellRulesEnabled,
    targetProfitRate: settings.targetProfitRate,
    hardStopLossRate: settings.hardStopLossRate,
    trailingStopRate: settings.trailingStopRate,
    maxHoldMinutes: settings.maxHoldMinutes,

    // v4.8.0: 포지션 사이징
    positionMaxRatio: settings.positionMaxRatio,
    positionMinCashRatio: settings.positionMinCashRatio,
    positionMaxPositions: settings.positionMaxPositions,

    // v4.8.0: 동적 스크리닝
    dynamicScreeningEnabled: settings.dynamicScreeningEnabled,
    screeningVolumeRatioMin: settings.screeningVolumeRatioMin,
    screeningMinMarketCap: settings.screeningMinMarketCap,
  });
});

// 설정 저장
router.post('/config', validate(saveConfigSchema), (req: Request, res: Response) => {
  const { appKey, appSecret, accountNo, accountProductCode, isVirtual, mcpEnabled,
    ollamaUrl, ollamaModel, ollamaEnabled,
    dartApiKey, dartEnabled,
    investmentStyle, debateMode,
    autoTradeEnabled, autoTradeMaxInvestment, autoTradeMaxPerStock, autoTradeMaxDailyTrades,
    scheduleKrx, scheduleNyse,
  } = req.body;

  const currentSettings = getSettings();
  if (!appSecret && !currentSettings.kisAppSecret) {
    return res.status(400).json({ error: '최초 저장 시 AppSecret은 필수입니다' });
  }

  saveSettings({
    kisAppKey: appKey,
    ...(appSecret ? { kisAppSecret: appSecret } : {}),
    kisAccountNo: accountNo || '',
    kisAccountProductCode: accountProductCode || '01',
    kisVirtual: !!isVirtual,
    mcpEnabled: !!mcpEnabled,

    ollamaUrl: ollamaUrl || 'http://localhost:11434',
    ollamaModel: ollamaModel || 'llama3.1',
    ollamaEnabled: !!ollamaEnabled,

    ...(dartApiKey ? { dartApiKey } : {}),
    dartEnabled: !!dartEnabled,

    investmentStyle: investmentStyle || 'balanced',
    debateMode: !!debateMode,
    stopLossPercent: Number(req.body.stopLossPercent) || 3,

    autoTradeEnabled: !!autoTradeEnabled,
    autoTradeMaxInvestment: Number(autoTradeMaxInvestment) || 10000000,
    autoTradeMaxPerStock: Number(autoTradeMaxPerStock) || 2000000,
    autoTradeMaxDailyTrades: Number(autoTradeMaxDailyTrades) || 10,
    autoTradeScoreThreshold: Number(req.body.autoTradeScoreThreshold) || 100,
    priceChangeThreshold: Number(req.body.priceChangeThreshold) || 2,

    ...(scheduleKrx ? { scheduleKrx } : {}),
    ...(scheduleNyse ? { scheduleNyse } : {}),

    nasSyncEnabled: req.body.nasSyncEnabled ?? false,
    nasSyncPath: req.body.nasSyncPath || '/Volumes/stock-manager',
    nasSyncTime: req.body.nasSyncTime || '0 20 * * *',
    deviceId: req.body.deviceId || '',
    nasHost: req.body.nasHost || '',
    nasShare: req.body.nasShare || 'stock-manager',
    nasUsername: req.body.nasUsername || '',
    ...(req.body.nasPassword ? { nasPassword: req.body.nasPassword } : {}),
    nasAutoMount: req.body.nasAutoMount ?? true,

    portfolioMaxHoldings: Number(req.body.portfolioMaxHoldings) || 10,
    portfolioMaxPerStockPercent: Number(req.body.portfolioMaxPerStockPercent) || 20,
    portfolioMaxSectorPercent: Number(req.body.portfolioMaxSectorPercent) || 40,
    portfolioRebalanceEnabled: req.body.portfolioRebalanceEnabled ?? false,
    portfolioMinCashPercent: Number(req.body.portfolioMinCashPercent) || 10,

    tradingRulesEnabled: req.body.tradingRulesEnabled ?? true,
    tradingRulesStrictMode: req.body.tradingRulesStrictMode ?? false,
    gapThresholdPercent: Number(req.body.gapThresholdPercent) || 3,
    volumeSurgeRatio: Number(req.body.volumeSurgeRatio) || 1.5,
    lowVolumeRatio: Number(req.body.lowVolumeRatio) || 0.7,
    sidewaysAtrPercent: Number(req.body.sidewaysAtrPercent) || 1.0,

    // v4.8.0: 매도 규칙
    sellRulesEnabled: req.body.sellRulesEnabled ?? true,
    targetProfitRate: Number(req.body.targetProfitRate) || 3.0,
    hardStopLossRate: Number(req.body.hardStopLossRate) || 2.0,
    trailingStopRate: Number(req.body.trailingStopRate) || 1.5,
    maxHoldMinutes: Number(req.body.maxHoldMinutes) || 60,

    // v4.8.0: 포지션 사이징
    positionMaxRatio: Number(req.body.positionMaxRatio) || 25,
    positionMinCashRatio: Number(req.body.positionMinCashRatio) || 20,
    positionMaxPositions: Number(req.body.positionMaxPositions) || 3,

    // v4.8.0: 동적 스크리닝
    dynamicScreeningEnabled: req.body.dynamicScreeningEnabled ?? true,
    screeningVolumeRatioMin: Number(req.body.screeningVolumeRatioMin) || 1.5,
    screeningMinMarketCap: Number(req.body.screeningMinMarketCap) || 500,
  });

  process.env.KIS_APP_KEY = appKey;
  if (appSecret) process.env.KIS_APP_SECRET = appSecret;
  process.env.KIS_VIRTUAL = isVirtual ? 'true' : 'false';

  // 스케줄러 재시작 (변경된 설정 반영)
  startScheduler();

  res.json({ message: '설정 저장 완료' });
});

// 시장 동향 (KOSPI/VIX/환율)
router.get('/market-context', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const ctx = await getMarketContext();
    res.json(ctx);
  } catch {
    res.json({});
  }
}));

// 해외 종목 여부 판별
function isOverseasTicker(ticker: string): { overseas: boolean; exchCode: string } {
  const stock: any = queryOne('SELECT market FROM stocks WHERE ticker = ?', [ticker]);
  const market = stock?.market || '';
  const overseasMarkets: Record<string, string> = { NASDAQ: 'NAS', NYSE: 'NYS', NASD: 'NAS', AMEX: 'AMS' };
  if (overseasMarkets[market]) {
    return { overseas: true, exchCode: overseasMarkets[market] };
  }
  // DB에 없으면 티커 형식으로 추정 (영문 대문자 1~5자 = 해외)
  if (/^[A-Z]{1,5}$/.test(ticker)) {
    return { overseas: true, exchCode: 'NAS' };
  }
  return { overseas: false, exchCode: '' };
}

// 일/주/월/년봉 캔들 데이터 조회
router.get('/candle/:ticker', asyncHandler(async (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const { period = 'D', startDate, endDate } = req.query;

  const { appKey, appSecret } = getKisConfig();
  if (!appKey || !appSecret) {
    return res.status(400).json({
      error: 'KIS API 설정이 필요합니다.',
      code: 'NO_CONFIG',
    });
  }

  try {
    const token = await getAccessToken();
    const { baseUrl } = getKisConfig();
    const settings = getSettings();

    const today = new Date();
    const end = (endDate as string) || today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDefault = new Date(today);
    startDefault.setFullYear(startDefault.getFullYear() - 1);
    const start = (startDate as string) || startDefault.toISOString().slice(0, 10).replace(/-/g, '');

    const { overseas, exchCode } = isOverseasTicker(ticker);

    if (overseas) {
      // 해외 주식 캔들 조회
      const trId = settings.kisVirtual ? 'VHHDFS76240000' : 'HHDFS76240000';
      const params = new URLSearchParams({
        AUTH: '',
        EXCD: exchCode,
        SYMB: ticker,
        GUBN: '0', // 0=일봉
        BYMD: end,
        MODP: '1', // 수정주가
      });

      const response = await fetch(
        `${baseUrl}/uapi/overseas-price/v1/quotations/dailyprice?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: `KIS API 오류: ${errText}` });
      }

      const data: any = await response.json();
      if (data.rt_cd !== '0') {
        return res.status(400).json({ error: `KIS API 오류: ${data.msg1}` });
      }

      const candles = (data.output2 || [])
        .filter((item: any) => item.xymd && Number(item.open) > 0)
        .map((item: any) => ({
          time: `${item.xymd.slice(0, 4)}-${item.xymd.slice(4, 6)}-${item.xymd.slice(6, 8)}`,
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.clos),
          volume: Number(item.tvol),
        }))
        .sort((a: any, b: any) => (a.time > b.time ? 1 : -1));

      // output1: 해외 종목 현재 시세 (last가 없으면 마지막 캔들 close로 fallback)
      const info = data.output1 || {};
      const lastCandle = candles[candles.length - 1];
      const overseasCurrentPrice = Number(info.last) || lastCandle?.close || 0;

      res.json({
        ticker,
        period,
        name: info.rsym ? ticker : ticker,
        currentPrice: overseasCurrentPrice,
        changeRate: Number(info.rate || 0),
        changeAmount: Number(info.diff || 0),
        candles,
        currency: 'USD',
      });
    } else {
      // 국내 주식 캔들 조회
      const params = new URLSearchParams({
        fid_cond_mrkt_div_code: 'J',
        fid_input_iscd: ticker,
        fid_input_date_1: start,
        fid_input_date_2: end,
        fid_period_div_code: period as string,
        fid_org_adj_prc: '0',
      });

      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST03010100',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: `KIS API 오류: ${errText}` });
      }

      const data: any = await response.json();

      if (data.rt_cd !== '0') {
        return res.status(400).json({ error: `KIS API 오류: ${data.msg1}` });
      }

      // lightweight-charts 형식으로 변환
      const candles = (data.output2 || [])
        .filter((item: any) => item.stck_bsop_date && Number(item.stck_oprc) > 0)
        .map((item: any) => ({
          time: `${item.stck_bsop_date.slice(0, 4)}-${item.stck_bsop_date.slice(4, 6)}-${item.stck_bsop_date.slice(6, 8)}`,
          open: Number(item.stck_oprc),
          high: Number(item.stck_hgpr),
          low: Number(item.stck_lwpr),
          close: Number(item.stck_clpr),
          volume: Number(item.acml_vol),
        }))
        .sort((a: any, b: any) => (a.time > b.time ? 1 : -1));

      const info = data.output1 || {};

      res.json({
        ticker,
        period,
        name: info.hts_kor_isnm || ticker,
        currentPrice: Number(info.stck_prpr || 0),
        changeRate: Number(info.prdy_ctrt || 0),
        changeAmount: Number(info.prdy_vrss || 0),
        candles,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: '캔들 데이터 조회 실패' });
  }
}));

// 해외주식 매수가능금액 조회 (외화 예수금)
async function fetchOverseasDeposit(token: string, appKey: string, appSecret: string, baseUrl: string, accountNo: string, productCode: string, isVirtual: boolean): Promise<number> {
  const trId = isVirtual ? 'VTTS3007R' : 'TTTS3007R';
  try {
    const params = new URLSearchParams({
      CANO: accountNo,
      ACNT_PRDT_CD: productCode || '01',
      OVRS_EXCG_CD: 'NASD',
      OVRS_ORD_UNPR: '0',
      ITEM_CD: '',
    });

    const response = await fetch(
      `${baseUrl}/uapi/overseas-stock/v1/trading/inquire-psamount?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      }
    );

    if (!response.ok) return 0;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return 0;

    const output = data.output || {};
    // frcr_ord_psbl_amt1: 외화주문가능금액 (USD 예수금)
    const deposit = Number(output.frcr_ord_psbl_amt1 || output.ovrs_ord_psbl_amt || 0);
    return deposit;
  } catch {
    return 0;
  }
}

// 해외 주식 잔고 조회 헬퍼
async function fetchOverseasBalance(token: string, appKey: string, appSecret: string, baseUrl: string, accountNo: string, productCode: string, isVirtual: boolean) {
  const trId = isVirtual ? 'CTRP6504R' : 'TTTS3012R';
  const exchanges = ['NASD', 'NYSE', 'AMEX'];
  const allHoldings: any[] = [];
  let totalPurchase = 0;
  let totalEval = 0;

  for (const exchg of exchanges) {
    let ctxAreaFK200 = '';
    let ctxAreaNK200 = '';
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        CANO: accountNo,
        ACNT_PRDT_CD: productCode || '01',
        OVRS_EXCG_CD: exchg,
        TR_CRCY_CD: 'USD',
        CTX_AREA_FK200: ctxAreaFK200,
        CTX_AREA_NK200: ctxAreaNK200,
      });

      const response = await fetch(
        `${baseUrl}/uapi/overseas-stock/v1/trading/inquire-balance?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
            custtype: 'P',
          },
        }
      );

      if (!response.ok) break;

      const data: any = await response.json();
      if (data.rt_cd !== '0') break;

      const items = (data.output1 || []).filter((item: any) => Number(item.ovrs_cblc_qty) > 0);
      for (const item of items) {
        const qty = Number(item.ovrs_cblc_qty);
        const avgPrc = Number(item.pchs_avg_pric);
        const curPrc = Number(item.now_pric2);
        const evalAmt = Number(item.ovrs_stck_evlu_amt);
        const purchaseAmt = avgPrc * qty;

        allHoldings.push({
          ticker: item.ovrs_pdno,
          name: item.ovrs_item_name,
          market: exchg,
          quantity: qty,
          avgPrice: Number(avgPrc.toFixed(2)),
          currentPrice: Number(curPrc.toFixed(2)),
          profitLossRate: purchaseAmt > 0 ? Number(((evalAmt - purchaseAmt) / purchaseAmt * 100).toFixed(2)) : 0,
          totalValue: Number(evalAmt.toFixed(2)),
          purchaseAmount: Number(purchaseAmt.toFixed(2)),
          currency: 'USD',
        });

        totalPurchase += purchaseAmt;
        totalEval += evalAmt;
      }

      // 연속조회
      const trCont = response.headers.get('tr_cont');
      if (trCont === 'M' || trCont === 'F') {
        ctxAreaFK200 = data.ctx_area_fk200 || '';
        ctxAreaNK200 = data.ctx_area_nk200 || '';
      } else {
        hasMore = false;
      }
    }
  }

  // 외화 예수금은 매수가능금액 API에서 별도 조회
  const overseasDeposit = await fetchOverseasDeposit(token, appKey, appSecret, baseUrl, accountNo, productCode, isVirtual);

  return {
    holdings: allHoldings,
    totalPurchaseAmount: Number(totalPurchase.toFixed(2)),
    totalEvalAmount: Number(totalEval.toFixed(2)),
    totalProfitLoss: Number((totalEval - totalPurchase).toFixed(2)),
    depositAmount: Number(overseasDeposit.toFixed(2)),
  };
}

// KIS 계좌 잔고 조회 (보유 종목 목록)
router.get('/balance', asyncHandler(async (_req: Request, res: Response) => {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  const settings = getSettings();

  if (!appKey || !appSecret) {
    return res.status(400).json({ error: 'KIS API 설정이 필요합니다.', code: 'NO_CONFIG' });
  }
  if (!settings.kisAccountNo) {
    return res.status(400).json({ error: '계좌번호가 설정되지 않았습니다.', code: 'NO_ACCOUNT' });
  }

  try {
    const token = await getAccessToken();

    // 국내 잔고 조회
    const domesticTrId = settings.kisVirtual ? 'VTTC8434R' : 'TTTC8434R';
    const params = new URLSearchParams({
      CANO: settings.kisAccountNo,
      ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: domesticTrId,
          custtype: 'P',
        },
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `KIS API 오류: ${errText}` });
    }

    const data: any = await response.json();
    if (data.rt_cd !== '0') {
      return res.status(400).json({ error: `KIS API 오류: ${data.msg1}` });
    }

    const holdings = (data.output1 || [])
      .filter((item: any) => Number(item.hldg_qty) > 0)
      .map((item: any) => ({
        ticker: item.pdno,
        name: item.prdt_name,
        quantity: Number(item.hldg_qty),
        avgPrice: Math.round(Number(item.pchs_avg_pric)),
        currentPrice: Number(item.prpr),
        profitLossRate: Number(item.evlu_pfls_rt),
        totalValue: Number(item.evlu_amt),
      }));

    // 계좌 요약 (output2)
    const summary = data.output2?.[0] || {};

    // 해외 잔고 조회
    let overseas = { holdings: [] as any[], totalPurchaseAmount: 0, totalEvalAmount: 0, totalProfitLoss: 0, depositAmount: 0 };
    try {
      overseas = await fetchOverseasBalance(token, appKey, appSecret, baseUrl, settings.kisAccountNo, settings.kisAccountProductCode || '01', settings.kisVirtual);
    } catch {
      // 해외 잔고 조회 실패 시 국내만 반환
    }

    // 국내 API(TTTC8434R)의 output2는 KRW 국내 자산만 포함
    // dnca_tot_amt = D+2 예수금 (실제 주문가능금액과 다를 수 있음)
    // 정확한 주문가능금액은 inquire-psbl-order(TTTC8908R)로 별도 조회
    const krwDeposit = Number(summary.dnca_tot_amt || 0);
    let orderableAmount = krwDeposit;
    try {
      const available = await getDomesticOrderableAmount();
      if (available > 0) orderableAmount = available;
    } catch {}

    res.json({
      holdings,
      totalPurchaseAmount: Number(summary.pchs_amt_smtl_amt || 0),
      totalEvalAmount: Number(summary.evlu_amt_smtl_amt || 0),
      totalProfitLoss: Number(summary.evlu_pfls_smtl_amt || 0),
      totalProfitLossRate: Number(summary.tot_evlu_pfls_rt || 0),
      depositAmount: krwDeposit,
      orderableAmount,
      overseasHoldings: overseas.holdings,
      overseasTotalPurchaseAmount: overseas.totalPurchaseAmount,
      overseasTotalEvalAmount: overseas.totalEvalAmount,
      overseasTotalProfitLoss: overseas.totalProfitLoss,
      overseasDepositAmount: overseas.depositAmount,
    });
  } catch (err: any) {
    res.status(500).json({ error: '잔고 조회 실패' });
  }
}));

// KIS 계좌 잔고를 포트폴리오로 가져오기
/**
 * Real-DB ReconcileDeps adapter. Pure logic lives in
 * services/portfolioReconcile.ts (so it can be unit tested).
 */
const dbReconcileDeps: ReconcileDeps = {
  getCurrentSmHoldings(markets) {
    const placeholders = markets.map(() => '?').join(',');
    return queryAll(
      `SELECT s.id as stock_id, s.ticker, s.market,
              COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END), 0) as current_qty
       FROM stocks s
       LEFT JOIN transactions t ON t.stock_id = s.id
       WHERE s.market IN (${placeholders})
       GROUP BY s.id
       HAVING current_qty > 0`,
      [...markets],
    ) as SmHoldingRow[];
  },
  findStockId(ticker) {
    const row = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
    return row?.id ?? null;
  },
  insertStock(ticker, name, market) {
    execute('INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)', [ticker, name, market, '']);
    const row = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
    return row?.id ?? 0;
  },
  insertBuy(stockId, quantity, price, date, memo) {
    execute(
      'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [stockId, 'BUY', quantity, price, 0, date, memo],
    );
  },
  insertSell(stockId, quantity, price, date, memo) {
    execute(
      'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [stockId, 'SELL', quantity, price, 0, date, memo],
    );
  },
  getLastBuyPrice(stockId) {
    const row = queryOne(
      "SELECT price FROM transactions WHERE stock_id = ? AND type = 'BUY' ORDER BY date DESC LIMIT 1",
      [stockId],
    );
    return row?.price ?? 0;
  },
};

router.post('/balance/import', asyncHandler(async (_req: Request, res: Response) => {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  const settings = getSettings();

  if (!appKey || !appSecret || !settings.kisAccountNo) {
    return res.status(400).json({ error: 'KIS API 설정 및 계좌번호가 필요합니다.' });
  }

  try {
    const token = await getAccessToken();
    const trId = settings.kisVirtual ? 'VTTC8434R' : 'TTTC8434R';

    const params = new URLSearchParams({
      CANO: settings.kisAccountNo,
      ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `KIS API 오류: ${errText}` });
    }

    const data = await response.json() as { rt_cd?: string; msg1?: string; output1?: Array<Record<string, string>> };
    if (data.rt_cd !== '0') {
      return res.status(400).json({ error: `KIS API 오류: ${data.msg1}` });
    }

    const today = new Date().toISOString().slice(0, 10);

    // 국내 잔고 스냅샷
    const krxSnapshots: KisHoldingSnapshot[] = [];
    for (const item of (data.output1 || [])) {
      const qty = Number(item.hldg_qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      krxSnapshots.push({
        ticker: item.pdno,
        name: item.prdt_name,
        market: 'KRX',
        quantity: qty,
        avgPrice: Math.round(Number(item.pchs_avg_pric)),
      });
    }

    const krxResult = reconcileMarket(krxSnapshots, ['KRX'], 'KRX', today, 'KIS 동기화', dbReconcileDeps);

    // 해외 잔고 스냅샷
    const marketMap: Record<string, 'NASDAQ' | 'NYSE' | 'AMEX'> = { NASD: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX' };
    let overseasResult: SyncResult = { added: [], adjusted: [], removed: [], unchanged: [] };

    try {
      const overseas = await fetchOverseasBalance(
        token, appKey, appSecret, baseUrl,
        settings.kisAccountNo, settings.kisAccountProductCode || '01', settings.kisVirtual,
      );
      const overseasSnapshots: KisHoldingSnapshot[] = overseas.holdings.map(item => ({
        ticker: item.ticker,
        name: item.name,
        market: marketMap[item.market] ?? 'NASDAQ',
        quantity: item.quantity,
        avgPrice: item.avgPrice,
      }));
      overseasResult = reconcileMarket(
        overseasSnapshots,
        ['NASDAQ', 'NYSE', 'AMEX'],
        'NASDAQ',
        today,
        'KIS 동기화 (해외)',
        dbReconcileDeps,
      );
    } catch {
      // 해외 잔고 가져오기 실패 시 국내만 처리
    }

    const totalChanges =
      krxResult.added.length + krxResult.adjusted.length + krxResult.removed.length +
      overseasResult.added.length + overseasResult.adjusted.length + overseasResult.removed.length;

    return res.json({
      message: totalChanges > 0
        ? `동기화 완료: 신규 ${krxResult.added.length + overseasResult.added.length}개, 조정 ${krxResult.adjusted.length + overseasResult.adjusted.length}개, 매도 ${krxResult.removed.length + overseasResult.removed.length}개`
        : '동기화 완료: 변경 사항 없음',
      krx: krxResult,
      overseas: overseasResult,
      // Backward compat fields
      imported: [...krxResult.added, ...overseasResult.added],
      skipped: [...krxResult.unchanged, ...overseasResult.unchanged],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '잔고 가져오기 실패';
    return res.status(500).json({ error: message });
  }
}));

// 호가(Bid/Ask) 조회
router.get('/quote-book/:ticker', asyncHandler(async (req: Request, res: Response) => {
  const tickerParam = req.params.ticker;
  const ticker = Array.isArray(tickerParam) ? tickerParam[0] : tickerParam;
  if (!ticker) {
    res.status(400).json({ error: 'ticker required' });
    return;
  }
  const market = ((req.query.market as string) || 'KRX').toUpperCase() as Market;

  if (!['KRX', 'NYSE', 'NASDAQ', 'AMEX', 'NASD'].includes(market)) {
    res.status(400).json({ error: 'market must be KRX | NYSE | NASDAQ | AMEX | NASD' });
    return;
  }

  const qb = await getQuoteBook(ticker, market);
  if (!qb) {
    res.status(404).json({ error: '호가 조회 실패 또는 미지원 시장' });
    return;
  }

  res.json(qb);
}));

export default router;
