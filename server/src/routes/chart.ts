import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings, saveSettings } from '../services/settings';
import { startScheduler } from '../services/scheduler';
import { getMarketContext } from '../services/stockPrice';
import { getDomesticOrderableAmount } from '../services/kisOrder';
import { syncKisBalance } from '../services/balanceSync';
import { correctHistoricalPrices } from '../services/correctHistoricalPrices';
import { kisFetchJson } from '../services/kisHttp';
import { getKisBalance } from '../services/kisBalance';
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
  });
});

// 설정 폼 복원용 조회 (AppSecret 제외)
router.get('/config/form', (_req: Request, res: Response) => {
  const settings = getSettings();
  res.json({
    appKey: settings.kisAppKey,
    accountNo: settings.kisAccountNo,
    accountProductCode: settings.kisAccountProductCode,
    isVirtual: settings.kisVirtual,
    hasSecret: !!settings.kisAppSecret,

    autoTradeEnabled: settings.autoTradeEnabled,
    scheduleKrx: settings.scheduleKrx,

    marketBrakeEnabled: settings.marketBrakeEnabled,
    marketBrakeKospiPercent: settings.marketBrakeKospiPercent,
    marketBrakeVixLevel: settings.marketBrakeVixLevel,

    selectionMode: settings.selectionMode,
    regimeFilterEnabled: settings.regimeFilterEnabled,
    nxtTradingEnabled: settings.nxtTradingEnabled,

    trailingActivatePercent: settings.trailingActivatePercent,
    trailingStopDropPercent: settings.trailingStopDropPercent,
  });
});

// 설정 저장
router.post('/config', validate(saveConfigSchema), (req: Request, res: Response) => {
  const {
    appKey, appSecret, accountNo, accountProductCode, isVirtual,
    autoTradeEnabled, scheduleKrx,
    marketBrakeEnabled, marketBrakeKospiPercent, marketBrakeVixLevel,
    selectionMode, regimeFilterEnabled, nxtTradingEnabled,
    trailingActivatePercent, trailingStopDropPercent,
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

    autoTradeEnabled: !!autoTradeEnabled,

    ...(scheduleKrx ? { scheduleKrx } : {}),

    marketBrakeEnabled: marketBrakeEnabled ?? true,
    marketBrakeKospiPercent: Number(marketBrakeKospiPercent) || 2.0,
    marketBrakeVixLevel: Number(marketBrakeVixLevel) || 30,

    ...(selectionMode === 'momentum' || selectionMode === 'marketcap'
      ? { selectionMode }
      : {}),
    ...(typeof regimeFilterEnabled === 'boolean' ? { regimeFilterEnabled } : {}),
    ...(typeof nxtTradingEnabled === 'boolean' ? { nxtTradingEnabled } : {}),
    ...(typeof trailingActivatePercent === 'number' ? { trailingActivatePercent } : {}),
    ...(typeof trailingStopDropPercent === 'number' ? { trailingStopDropPercent } : {}),
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

    const { ok, status, data, rateLimited } = await kisFetchJson<any>(
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
      },
      `candle-${ticker}`,
    );

    if (!ok || !data) {
      const msg = rateLimited
        ? 'KIS 호출 한도 초과 — 잠시 후 다시 시도하세요.'
        : `KIS API 오류: ${data?.msg1 ?? `HTTP ${status}`}`;
      return res.status(rateLimited ? 503 : 400).json({ error: msg, code: data?.msg_cd });
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

// KIS 계좌 잔고 조회 (보유 종목 목록) — 공통 서비스(getKisBalance)로 위임: 큐+캐시+재시도
router.get('/balance', asyncHandler(async (_req: Request, res: Response) => {
  const { appKey, appSecret } = getKisConfig();
  const settings = getSettings();

  if (!appKey || !appSecret) {
    return res.status(400).json({ error: 'KIS API 설정이 필요합니다.', code: 'NO_CONFIG' });
  }
  if (!settings.kisAccountNo) {
    return res.status(400).json({ error: '계좌번호가 설정되지 않았습니다.', code: 'NO_ACCOUNT' });
  }

  const balance = await getKisBalance();
  if (!balance) {
    return res.status(503).json({
      error: 'KIS 호출이 일시적으로 한도를 초과했거나 응답이 없습니다. 잠시 후 다시 시도하세요.',
    });
  }
  res.json(balance);
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

// 과거 KIS 동기화 트랜잭션의 평단을 실제 체결가로 보정.
// dryRun=true (기본): 미리보기만, false: 실제 update.
router.post('/balance/correct-prices', asyncHandler(async (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun !== false; // 명시적 false 만 적용
  const result = await correctHistoricalPrices(dryRun);
  return res.json({
    dryRun,
    ...result,
    message: dryRun
      ? `미리보기: ${result.candidates}건 보정 가능, ${result.unmatched}건 매치 불가`
      : `완료: ${result.applied}건 보정, ${result.unmatched}건 매치 불가`,
  });
}));

export default router;
