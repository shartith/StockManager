import { Router, Request, Response } from 'express';
import { getNotifications, getUnreadCount, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications } from '../services/notification';

const router = Router();

/** 알림 목록 */
router.get('/', (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const notifications = getNotifications(limit, offset);
  const unreadCount = getUnreadCount();
  res.json({ notifications, unreadCount });
});

/** 읽지 않은 알림 수 */
router.get('/unread-count', (_req: Request, res: Response) => {
  res.json({ count: getUnreadCount() });
});

/** 단일 알림 읽음 처리 */
router.patch('/:id/read', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  markAsRead(id);
  res.json({ message: '읽음 처리 완료' });
});

/** 전체 읽음 처리 */
router.post('/read-all', (_req: Request, res: Response) => {
  markAllAsRead();
  res.json({ message: '전체 읽음 처리 완료' });
});

/**
 * 전체 알림 삭제. NOTE: more specific path must be registered BEFORE the
 * `/:id` parameter route, otherwise express matches "all" as an id.
 */
router.delete('/all', (_req: Request, res: Response) => {
  const deleted = deleteAllNotifications();
  res.json({ message: `${deleted}건 삭제 완료`, deleted });
});

/** 알림 삭제 */
router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  deleteNotification(id);
  res.json({ message: '삭제 완료' });
});

export default router;
