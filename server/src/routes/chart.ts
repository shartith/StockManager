import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings, saveSettings } from '../services/settings';
import { startScheduler } from '../services/scheduler';
import { getMarketContext } from '../services/stockPrice';
import { getDomesticOrderableAmount } from '../services/kisOrder';
import { getQuoteBook, type Market } from '../services/quoteBook';
import { syncKisBalance } from '../services/balanceSync';
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

    llmProvider: settings.llmProvider,
    llmUrl: settings.llmUrl,
    llmModel: settings.llmModel,
    llmEnabled: settings.llmEnabled,
    hasLlmApiKey: !!settings.llmApiKey,

    dartEnabled: settings.dartEnabled,
    hasDartKey: !!settings.dartApiKey,

    autoTradeEnabled: settings.autoTradeEnabled,

    scheduleKrx: settings.scheduleKrx,

    sellRulesEnabled: settings.sellRulesEnabled,
    targetProfitRate: settings.targetProfitRate,
    hardStopLossRate: settings.hardStopLossRate,
    trailingStopRate: settings.trailingStopRate,
    trailingActivatePercent: settings.trailingActivatePercent,
    sidewaysMinutes: settings.sidewaysMinutes,
    lossMinutes: settings.lossMinutes,
    profitThresholdPercent: settings.profitThresholdPercent,

    positionMaxPositions: settings.positionMaxPositions,
    eodProfitTakePercent: settings.eodProfitTakePercent,
    entryGainPercent: settings.entryGainPercent,
    marketBrakeEnabled: settings.marketBrakeEnabled,
    marketBrakeKospiPercent: settings.marketBrakeKospiPercent,
    marketBrakeVixLevel: settings.marketBrakeVixLevel,
    gapUpMaxPercent: settings.gapUpMaxPercent,
    reEntryCooldownMinutes: settings.reEntryCooldownMinutes,
  });
});

// 설정 저장
router.post('/config', validate(saveConfigSchema), (req: Request, res: Response) => {
  const { appKey, appSecret, accountNo, accountProductCode, isVirtual, mcpEnabled,
    llmProvider, llmUrl, llmModel, llmEnabled, llmApiKey,
    dartApiKey, dartEnabled,
    autoTradeEnabled, scheduleKrx,
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

    llmProvider: llmProvider === 'ollama' ? 'ollama' : 'openai',
    llmUrl: llmUrl || 'https://ai.unids.kr/v1',
    llmModel: llmModel || '',
    llmEnabled: llmEnabled !== false,
    ...(typeof llmApiKey === 'string' && llmApiKey.length > 0 ? { llmApiKey } : {}),

    ...(dartApiKey ? { dartApiKey } : {}),
    dartEnabled: !!dartEnabled,

    autoTradeEnabled: !!autoTradeEnabled,

    ...(scheduleKrx ? { scheduleKrx } : {}),

    sellRulesEnabled: req.body.sellRulesEnabled ?? true,
    targetProfitRate: Number(req.body.targetProfitRate) || 3.0,
    hardStopLossRate: Number(req.body.hardStopLossRate) || 2.0,
    trailingStopRate: Number(req.body.trailingStopRate) || 1.5,
    trailingActivatePercent: Number(req.body.trailingActivatePercent) || 3.0,
    sidewaysMinutes: Number(req.body.sidewaysMinutes) || 60,
    lossMinutes: Number(req.body.lossMinutes) || 60,
    profitThresholdPercent: Number(req.body.profitThresholdPercent) || 0.5,

    positionMaxPositions: Number(req.body.positionMaxPositions) || 5,
    eodProfitTakePercent: Number(req.body.eodProfitTakePercent) || 3.0,

    entryGainPercent: Number(req.body.entryGainPercent) || 1.0,
    marketBrakeEnabled: req.body.marketBrakeEnabled ?? true,
    marketBrakeKospiPercent: Number(req.body.marketBrakeKospiPercent) || 2.0,
    marketBrakeVixLevel: Number(req.body.marketBrakeVixLevel) || 30,
    gapUpMaxPercent: Number(req.body.gapUpMaxPercent) || 3.0,
    reEntryCooldownMinutes: Number(req.body.reEntryCooldownMinutes) ?? 30,
  });

  process.env.KIS_APP_KEY = appKey;
  if (appSecret) process.env.KIS_APP_SECRET = appSecret;
  process.env.KIS_VIRTUAL = isVirtual ? 'true' : 'false';

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

// 일/주/월/년봉 캔들 데이터 조회 (KRX)
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

    const today = new Date();
    const end = (endDate as string) || today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDefault = new Date(today);
    startDefault.setFullYear(startDefault.getFullYear() - 1);
    const start = (startDate as string) || startDefault.toISOString().slice(0, 10).replace(/-/g, '');

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
  } catch (err: any) {
    res.status(500).json({ error: '캔들 데이터 조회 실패' });
  }
}));

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
    });
  } catch (err: any) {
    res.status(500).json({ error: '잔고 조회 실패' });
  }
}));

// KIS 잔고 → DB 동기화 (서비스로 위임 — services/balanceSync.ts)
router.post('/balance/import', asyncHandler(async (_req: Request, res: Response) => {
  const outcome = await syncKisBalance('KIS 동기화');
  if (!outcome.ok) {
    return res.status(400).json({ error: outcome.message, detail: outcome.error });
  }
  const result = outcome.result!;
  return res.json({
    message: outcome.message,
    krx: result,
    imported: result.added,
    skipped: result.unchanged,
  });
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

  if (market !== 'KRX') {
    res.status(400).json({ error: 'market must be KRX' });
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
