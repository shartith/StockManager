/**
 * 알림 서비스
 * 현재: DB 기반 알림 내역 관리
 * 추후: 메신저(Telegram, Slack 등) 연동 확장 가능
 */

import { queryAll, queryOne, execute } from '../db';
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
 */
export function deleteAllNotifications(): number {
  const { changes } = execute('DELETE FROM notifications', []);
  logger.info({ changes }, 'All notifications deleted');
  return changes;
}
