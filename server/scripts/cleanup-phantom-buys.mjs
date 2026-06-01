#!/usr/bin/env node
/**
 * 운영 DB phantom BUY 정리 (v5.6.2 fix 후속).
 *
 * 배경:
 *   v5.4~v5.6 에서 balanceSync.getCurrentSmHoldings 가 market IN ('KRX') 로만 보유분을
 *   조회해, top10Strategy 가 'KOSPI'/'KOSDAQ' 로 저장한 종목이 보유 0 으로 오인됐다.
 *   그 결과 가져오기/EOD reconcile 마다 신규 BUY(메모 "... 동기화 (신규)")가 중복 누적돼
 *   보유수량이 부풀고, 안 산 종목이 매수로 표시됐다.
 *
 *   코드는 v5.6.2 에서 고쳤지만(향후 중복 차단), 이미 DB 에 박힌 과거 phantom 행은
 *   이 스크립트로 정리한다. 실제 KIS 체결("자동매매 (KIS: ...)") · 매도 · 조정 거래는
 *   절대 건드리지 않는다.
 *
 * 식별:
 *   phantom = type='BUY' AND deleted_at IS NULL AND memo LIKE '%(신규)%'
 *   reconcile insertBuy 만 "... (신규)" 접미사를 생성한다. 수동 가져오기("KIS 동기화 (신규)")와
 *   EOD cron("EOD 자동 reconcile (신규)") 둘 다 포함된다. 실제 체결("자동매매 (KIS: ...) / Top10 #N
 *   신규 진입")은 "(신규)" 부분문자열이 없어 제외된다.
 *
 * 모드:
 *   (기본)        종목별 phantom 신규 BUY 가 2건 이상이면 가장 이른 1건만 남기고 나머지 soft-delete
 *   --aggressive  종목에 실제 BUY(자동매매 등)가 따로 있으면 그 종목의 phantom 신규 BUY 전부 soft-delete
 *
 * 안전장치:
 *   - 기본 DRY-RUN: --apply 를 줘야 실제 변경
 *   - --apply 시 DB 파일 자동 백업 (<db>.bak-<timestamp>)
 *   - HARD DELETE 안 함: deleted_at 설정 + memo 에 ' [phantom-cleanup <date>]' 표식 (복구 가능)
 *
 * 사용:
 *   node scripts/cleanup-phantom-buys.mjs --db /path/stock-manager.db            # 미리보기
 *   node scripts/cleanup-phantom-buys.mjs --db /path/stock-manager.db --apply    # 실제 정리
 *   node scripts/cleanup-phantom-buys.mjs --db ... --aggressive --apply
 *
 * 롤백:
 *   UPDATE transactions SET deleted_at=NULL WHERE memo LIKE '%[phantom-cleanup%';
 */

import Database from 'better-sqlite3';
import { existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { apply: false, aggressive: false, db: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--aggressive') args.aggressive = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a.startsWith('--db=')) args.db = a.slice(5);
  }
  return args;
}

function resolveDbPath(cli) {
  if (cli) return cli;
  if (process.env.STOCK_MANAGER_DB_PATH) return process.env.STOCK_MANAGER_DB_PATH;
  return path.resolve(process.cwd(), 'data', 'stock-manager.db');
}

function stamp() {
  // 표준 node 스크립트 — Date 사용 OK.
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

const PHANTOM_WHERE = `t.type='BUY' AND t.deleted_at IS NULL AND t.memo LIKE '%(신규)%'`;

function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolveDbPath(args.db);

  if (!existsSync(dbPath)) {
    console.error(`✗ DB 파일 없음: ${dbPath}`);
    console.error('  --db <경로> 또는 STOCK_MANAGER_DB_PATH 로 지정하세요.');
    process.exit(1);
  }

  console.log(`DB        : ${dbPath}`);
  console.log(`모드      : ${args.aggressive ? 'AGGRESSIVE' : 'CONSERVATIVE'}`);
  console.log(`실행      : ${args.apply ? 'APPLY (실제 변경)' : 'DRY-RUN (미리보기)'}`);
  console.log('');

  const db = new Database(dbPath, { readonly: !args.apply });

  // phantom 후보 (종목별 정렬)
  const phantoms = db.prepare(`
    SELECT t.id, t.stock_id, s.ticker, s.name, s.market, t.quantity, t.price, t.date, t.created_at, t.memo
    FROM transactions t JOIN stocks s ON s.id = t.stock_id
    WHERE ${PHANTOM_WHERE}
    ORDER BY t.stock_id, t.date, t.id
  `).all();

  if (phantoms.length === 0) {
    console.log('✓ phantom 신규 BUY 없음 — 정리할 항목이 없습니다.');
    db.close();
    return;
  }

  // 종목에 "실제 BUY"(phantom 아닌 BUY)가 있는지 — aggressive 판정용
  const hasRealBuyStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM transactions
    WHERE stock_id = ? AND type='BUY' AND deleted_at IS NULL
      AND memo NOT LIKE '%(신규)%'
  `);
  const netQtyStmt = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type='BUY' THEN quantity ELSE -quantity END), 0) AS q
    FROM transactions WHERE stock_id = ? AND deleted_at IS NULL
  `);

  // 종목별 그룹핑
  const byStock = new Map();
  for (const p of phantoms) {
    if (!byStock.has(p.stock_id)) byStock.set(p.stock_id, []);
    byStock.get(p.stock_id).push(p);
  }

  const toDelete = [];
  const report = [];

  for (const [stockId, rows] of byStock) {
    const hasReal = hasRealBuyStmt.get(stockId).n > 0;
    let deleteRows;

    if (args.aggressive && hasReal) {
      deleteRows = rows;                 // 실제 BUY 가 따로 있으니 phantom 신규 전부 제거
    } else if (rows.length >= 2) {
      deleteRows = rows.slice(1);        // 가장 이른 1건만 남기고 제거
    } else {
      deleteRows = [];                   // 단건 + (보수 모드 or 실제BUY 없음) → 보존
    }

    if (deleteRows.length === 0) continue;

    const before = netQtyStmt.get(stockId).q;
    const delQty = deleteRows.reduce((s, r) => s + r.quantity, 0);
    report.push({
      ticker: rows[0].ticker,
      name: rows[0].name,
      market: rows[0].market,
      hasReal,
      phantomTotal: rows.length,
      deleting: deleteRows.length,
      before,
      after: before - delQty,
    });
    toDelete.push(...deleteRows.map(r => r.id));
  }

  // 리포트 출력
  console.log(`phantom 신규 BUY 거래 총 ${phantoms.length}건 / 영향 종목 ${byStock.size}개`);
  console.log(`삭제 대상: ${toDelete.length}건 (${report.length}개 종목)\n`);

  if (report.length > 0) {
    console.log('종목         시장     실제BUY  phantom  삭제   보유수량(전→후)');
    console.log('─'.repeat(70));
    for (const r of report) {
      const name = (r.name || '').slice(0, 8).padEnd(9);
      console.log(
        `${(r.ticker || '').padEnd(8)} ${name} ${(r.market || "''").padEnd(7)} ` +
        `${String(r.hasReal ? 'Y' : 'N').padEnd(7)} ${String(r.phantomTotal).padEnd(8)} ` +
        `${String(r.deleting).padEnd(5)} ${r.before} → ${r.after}`,
      );
    }
    console.log('');
  } else {
    console.log('현재 모드 기준 삭제 대상이 없습니다. (--aggressive 로 더 적극 정리 가능)\n');
  }

  if (!args.apply) {
    console.log('DRY-RUN 종료 — 실제 변경 없음. 적용하려면 --apply 를 추가하세요.');
    db.close();
    return;
  }

  if (toDelete.length === 0) {
    console.log('적용할 변경 없음.');
    db.close();
    return;
  }

  // 백업
  const backup = `${dbPath}.bak-${stamp()}`;
  copyFileSync(dbPath, backup);
  console.log(`✓ 백업 생성: ${backup}`);

  // soft-delete (트랜잭션)
  const marker = ` [phantom-cleanup ${new Date().toISOString().slice(0, 10)}]`;
  const upd = db.prepare(
    `UPDATE transactions SET deleted_at = datetime('now'), memo = memo || ? WHERE id = ?`,
  );
  const tx = db.transaction((ids) => {
    for (const id of ids) upd.run(marker, id);
  });
  tx(toDelete);

  console.log(`✓ ${toDelete.length}건 soft-delete 완료 (deleted_at 설정 + memo 표식).`);
  console.log('  롤백: UPDATE transactions SET deleted_at=NULL WHERE memo LIKE \'%[phantom-cleanup%\';');
  console.log('\n다음 단계: v5.6.2 배포 후 "가져오기"를 1회 실행하면 잔여분이 KIS 잔고 기준으로 최종 정합화됩니다.');
  db.close();
}

main();
