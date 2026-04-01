import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings, saveSettings } from '../services/settings';
import { startScheduler } from '../services/scheduler';
import { queryOne, execute } from '../db';

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

    externalAiProvider: settings.externalAiProvider,
    externalAiModel: settings.externalAiModel,
    hasExternalAiKey: !!settings.externalAiApiKey,

    autoTradeEnabled: settings.autoTradeEnabled,
    autoTradeMaxInvestment: settings.autoTradeMaxInvestment,
    autoTradeMaxPerStock: settings.autoTradeMaxPerStock,
    autoTradeMaxDailyTrades: settings.autoTradeMaxDailyTrades,

    scheduleKrx: settings.scheduleKrx,
    scheduleNyse: settings.scheduleNyse,
  });
});

// 설정 저장
router.post('/config', (req: Request, res: Response) => {
  const { appKey, appSecret, accountNo, accountProductCode, isVirtual, mcpEnabled,
    ollamaUrl, ollamaModel, ollamaEnabled,
    externalAiProvider, externalAiApiKey, externalAiModel,
    autoTradeEnabled, autoTradeMaxInvestment, autoTradeMaxPerStock, autoTradeMaxDailyTrades,
    scheduleKrx, scheduleNyse,
  } = req.body;

  if (!appKey) {
    return res.status(400).json({ error: 'AppKey는 필수입니다' });
  }
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

    externalAiProvider: externalAiProvider || 'none',
    ...(externalAiApiKey ? { externalAiApiKey } : {}),
    externalAiModel: externalAiModel || '',

    autoTradeEnabled: !!autoTradeEnabled,
    autoTradeMaxInvestment: Number(autoTradeMaxInvestment) || 10000000,
    autoTradeMaxPerStock: Number(autoTradeMaxPerStock) || 2000000,
    autoTradeMaxDailyTrades: Number(autoTradeMaxDailyTrades) || 10,

    ...(scheduleKrx ? { scheduleKrx } : {}),
    ...(scheduleNyse ? { scheduleNyse } : {}),
  });

  process.env.KIS_APP_KEY = appKey;
  if (appSecret) process.env.KIS_APP_SECRET = appSecret;
  process.env.KIS_VIRTUAL = isVirtual ? 'true' : 'false';

  // 스케줄러 재시작 (변경된 설정 반영)
  startScheduler();

  res.json({ message: '설정 저장 완료' });
});

// 일/주/월/년봉 캔들 데이터 조회
router.get('/candle/:ticker', async (req: Request, res: Response) => {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message || '캔들 데이터 조회 실패' });
  }
});

// KIS 계좌 잔고 조회 (보유 종목 목록)
router.get('/balance', async (_req: Request, res: Response) => {
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

    res.json({
      holdings,
      totalPurchaseAmount: Number(summary.pchs_amt_smtl_amt || 0),
      totalEvalAmount: Number(summary.evlu_amt_smtl_amt || 0),
      totalProfitLoss: Number(summary.evlu_pfls_smtl_amt || 0),
      totalProfitLossRate: Number(summary.tot_evlu_pfls_rt || 0),
      depositAmount: Number(summary.dnca_tot_amt || 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '잔고 조회 실패' });
  }
});

// KIS 계좌 잔고를 포트폴리오로 가져오기
router.post('/balance/import', async (_req: Request, res: Response) => {
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

    const data: any = await response.json();
    if (data.rt_cd !== '0') {
      return res.status(400).json({ error: `KIS API 오류: ${data.msg1}` });
    }

    const today = new Date().toISOString().slice(0, 10);
    const imported: string[] = [];
    const skipped: string[] = [];

    for (const item of (data.output1 || [])) {
      const qty = Number(item.hldg_qty);
      if (qty <= 0) continue;

      const ticker = item.pdno;
      const name = item.prdt_name;
      const avgPrice = Math.round(Number(item.pchs_avg_pric));

      // 종목이 없으면 추가
      let stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
      if (!stock) {
        execute('INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)', [ticker, name, 'KRX', '']);
        stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
      }

      // 이미 거래 내역이 있으면 스킵
      const existingTx = queryOne('SELECT id FROM transactions WHERE stock_id = ?', [stock.id]);
      if (existingTx) {
        skipped.push(ticker);
        continue;
      }

      // 매수 거래로 등록
      execute(
        'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [stock.id, 'BUY', qty, avgPrice, 0, today, 'KIS 계좌 잔고 가져오기']
      );
      imported.push(ticker);
    }

    res.json({
      message: `${imported.length}개 종목 가져오기 완료`,
      imported,
      skipped,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '잔고 가져오기 실패' });
  }
});

export default router;
