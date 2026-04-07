/**
 * 시스템 이벤트 로그
 * 에러, 미대응 상황, 후속조치 필요 사항을 기록하고 UI에서 조회 가능하게 함
 */

import { execute, queryAll, queryOne, logAudit } from '../db';
import { getSettings } from './settings';
import logger from '../logger';

export type EventSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type EventCategory =
  | 'ORDER_UNFILLED'     // 미체결 주문
  | 'ORDER_FAILED'       // 주문 실패
  | 'OLLAMA_DOWN'        // LLM 연결 실패
  | 'KIS_API_ERROR'      // KIS API 오류
  | 'TOKEN_EXPIRED'      // 토큰 만료
  | 'STOP_LOSS'          // 손절 실행
  | 'PROFIT_TAKING'      // 수익 실현
  | 'RESERVED_ORDER'     // 예약 주문 실행
  | 'SYSTEM_RESTART'     // 시스템 재시작
  | 'DATA_ERROR'         // 데이터 오류
  | 'GENERAL';           // 일반

/** LLM에 이벤트 대응 방안 질의 */
async function getAiAdvice(severity: string, category: string, title: string, detail: string, ticker: string): Promise<string> {
  try {
    const settings = getSettings();
    if (!settings.ollamaEnabled || !settings.ollamaUrl) return '';

    const prompt = `자동매매 시스템에서 다음 이벤트가 발생했습니다. 즉시 취할 수 있는 조치와 향후 방지 방안을 2~3문장으로 제안하세요.

심각도: ${severity}
분류: ${category}
제목: ${title}
상세: ${detail}
${ticker ? `종목: ${ticker}` : ''}`;

    const res = await fetch(`${settings.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel || 'qwen3:4b',
        prompt, stream: false,
        options: { temperature: 0.3, num_predict: 300 },
      }),
    });
    if (!res.ok) return '';
    const data: any = await res.json();
    return data.response?.trim() || '';
  } catch {
    return '';
  }
}

/** 시스템 이벤트 기록 (WARN 이상이면 LLM 조언 포함) */
export async function logSystemEvent(
  severity: EventSeverity,
  category: EventCategory | string,
  title: string,
  detail: string = '',
  ticker: string = '',
): Promise<number> {
  // WARN 이상이면 LLM에 조언 질의
  let aiAdvice = '';
  if (severity !== 'INFO') {
    aiAdvice = await getAiAdvice(severity, category, title, detail, ticker).catch(() => '');
  }

  const fullDetail = aiAdvice ? `${detail}\n\n[AI 조언] ${aiAdvice}` : detail;

  const { lastId } = execute(
    'INSERT INTO system_events (severity, category, title, detail, ticker) VALUES (?, ?, ?, ?, ?)',
    [severity, category, title, fullDetail, ticker]
  );
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    logger.error({ severity, category, title, ticker }, 'System event');
    if (aiAdvice) logger.info({ aiAdvice: aiAdvice.slice(0, 100) }, 'AI advice for system event');
  }
  return lastId;
}

/** 이벤트 해결 처리 */
export function resolveEvent(eventId: number, resolution: string): void {
  // NOTE: SQLite parses double-quoted strings as column identifiers in
  // strict mode (which better-sqlite3 enforces). Use single quotes for
  // datetime() literals. sql.js was lenient about this.
  execute(
    "UPDATE system_events SET resolved = 1, resolved_at = datetime('now'), resolution = ? WHERE id = ?",
    [resolution, eventId]
  );
}

/** 미해결 이벤트 조회 */
export function getUnresolvedEvents(limit: number = 50): any[] {
  return queryAll(
    'SELECT * FROM system_events WHERE resolved = 0 ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

/** 전체 이벤트 조회 (최근) */
export function getRecentEvents(limit: number = 100): any[] {
  return queryAll(
    'SELECT * FROM system_events ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

/** 심각도별 카운트 */
export function getEventCounts(): { total: number; critical: number; error: number; warn: number; unresolved: number } {
  const total = queryOne("SELECT COUNT(*) as cnt FROM system_events WHERE created_at >= datetime('now', '-7 days')")?.cnt || 0;
  const critical = queryOne("SELECT COUNT(*) as cnt FROM system_events WHERE severity = 'CRITICAL' AND resolved = 0")?.cnt || 0;
  const error = queryOne("SELECT COUNT(*) as cnt FROM system_events WHERE severity = 'ERROR' AND resolved = 0")?.cnt || 0;
  const warn = queryOne("SELECT COUNT(*) as cnt FROM system_events WHERE severity = 'WARN' AND resolved = 0")?.cnt || 0;
  const unresolved = queryOne("SELECT COUNT(*) as cnt FROM system_events WHERE resolved = 0")?.cnt || 0;
  return { total, critical, error, warn, unresolved };
}

/**
 * 단일 시스템 이벤트 삭제.
 * @param eventId 삭제할 이벤트의 id
 * @returns 삭제된 행 수 (0 or 1)
 */
export function deleteEvent(eventId: number): number {
  const { changes } = execute('DELETE FROM system_events WHERE id = ?', [eventId]);
  return changes;
}

/**
 * 전체 시스템 이벤트 삭제. v4.7.1: OLLAMA_DOWN burst 같은 누적 노이즈를
 * 사용자가 일괄 정리할 수 있도록.
 *
 * v4.7.3 (security review fix):
 *   - audit_log에 영구 기록 (어떤 카테고리/심각도가 몇 건 삭제되었는지)
 *   - 삭제 전 unresolved CRITICAL 이벤트 카운트를 audit에 포함
 *
 * @param onlyResolved true이면 해결 처리된 이벤트만 삭제 (기본 false)
 */
export function deleteAllEvents(onlyResolved = false): number {
  // Capture an audit snapshot of what is about to be deleted, including
  // any unresolved CRITICAL events that the operator might be erasing.
  const snapshot = queryOne(
    onlyResolved
      ? "SELECT COUNT(*) as total, SUM(CASE WHEN severity='CRITICAL' THEN 1 ELSE 0 END) as critical FROM system_events WHERE resolved = 1"
      : "SELECT COUNT(*) as total, SUM(CASE WHEN severity='CRITICAL' AND resolved=0 THEN 1 ELSE 0 END) as critical FROM system_events",
  );

  const sql = onlyResolved
    ? 'DELETE FROM system_events WHERE resolved = 1'
    : 'DELETE FROM system_events';
  const { changes } = execute(sql, []);

  // Persistent audit trail (separate from pino logging)
  try {
    logAudit('system_events', null, 'DELETE', null, {
      bulk: true,
      onlyResolved,
      deleted: changes,
      criticalDeleted: Number(snapshot?.critical ?? 0),
    });
  } catch {
    // Audit log failure must not block the user-facing delete
  }

  logger.info({ changes, onlyResolved, criticalDeleted: snapshot?.critical }, 'System events bulk deleted');
  return changes;
}
