/**
 * 알림 서비스
 * 현재: DB 기반 알림 내역 관리
 * 추후: 메신저(Telegram, Slack 등) 연동 확장 가능
 */

import { queryAll, queryOne, execute, logAudit } from '../db';
import logger from '../logger';

export interface NotificationPayload {
  type: string;          // PROMOTION, AUTO_TRADE, SIGNAL, INFO 등
  title: string;
  message: string;
  ticker?: string;
  market?: string;
  actionUrl?: string;
}

/** 알림 생성 (DB 저장 + 추후 메신저 전송) */
export function createNotification(payload: NotificationPayload): number {
  const { lastId } = execute(
    'INSERT INTO notifications (type, title, message, ticker, market, action_url) VALUES (?, ?, ?, ?, ?, ?)',
    [payload.type, payload.title, payload.message, payload.ticker || '', payload.market || '', payload.actionUrl || '']
  );

  logger.info({ type: payload.type, title: payload.title }, 'Notification created');

  // WebSocket push to connected clients
  const broadcastChannel = (global as any).__wsBroadcastChannel;
  if (broadcastChannel) {
    broadcastChannel('notifications', {
      id: lastId,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      ticker: payload.ticker,
    });
  }

  return lastId;
}

/** 읽지 않은 알림 수 */
export function getUnreadCount(): number {
  const row = queryOne('SELECT COUNT(*) as cnt FROM notifications WHERE is_read = 0');
  return row?.cnt || 0;
}

/** 알림 목록 조회 */
export function getNotifications(limit = 50, offset = 0): any[] {
  return queryAll(
    'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
}

/** 알림 읽음 처리 */
export function markAsRead(id: number) {
  execute('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
}

/** 모든 알림 읽음 처리 */
export function markAllAsRead() {
  execute('UPDATE notifications SET is_read = 1 WHERE is_read = 0', []);
}

/** 알림 삭제 */
export function deleteNotification(id: number) {
  execute('DELETE FROM notifications WHERE id = ?', [id]);
}

/**
 * 모든 알림 삭제. v4.7.1: 사용자가 알림 패널에서 일괄 정리할 수 있도록.
 * 삭제된 행 수를 반환하여 UI가 사용자에게 결과를 표시할 수 있게 한다.
 *
 * v4.7.3: audit_log에 영구 기록 (몇 건 / 미읽음 몇 건이 삭제되었는지).
 */
export function deleteAllNotifications(): number {
  const snapshot = queryOne(
    'SELECT COUNT(*) as total, SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) as unread FROM notifications',
  );
  const { changes } = execute('DELETE FROM notifications', []);

  try {
    logAudit('notifications', null, 'DELETE', null, {
      bulk: true,
      deleted: changes,
      unreadDeleted: Number(snapshot?.unread ?? 0),
    });
  } catch {
    // Audit log failure must not block the user-facing delete
  }

  logger.info({ changes, unread: snapshot?.unread }, 'All notifications deleted');
  return changes;
}
