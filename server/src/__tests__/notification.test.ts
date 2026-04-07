/**
 * v4.7.1: notification CRUD + bulk delete
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, execute } from '../db';
import {
  createNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllNotifications,
} from '../services/notification';

describe('notification CRUD', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    execute('DELETE FROM notifications');
  });

  describe('createNotification', () => {
    it('inserts a notification and returns its id', () => {
      const id = createNotification({
        type: 'INFO',
        title: 'test',
        message: 'hello',
      });
      expect(id).toBeGreaterThan(0);

      const all = getNotifications();
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe('test');
      expect(all[0].is_read).toBe(0);
    });

    it('respects optional ticker / market / actionUrl', () => {
      createNotification({
        type: 'AUTO_TRADE',
        title: 'buy filled',
        message: '50 shares',
        ticker: '005930',
        market: 'KRX',
        actionUrl: '/portfolio',
      });
      const all = getNotifications();
      expect(all[0].ticker).toBe('005930');
      expect(all[0].market).toBe('KRX');
      expect(all[0].action_url).toBe('/portfolio');
    });
  });

  describe('getUnreadCount + markAsRead + markAllAsRead', () => {
    beforeEach(() => {
      createNotification({ type: 'INFO', title: 'a', message: '' });
      createNotification({ type: 'INFO', title: 'b', message: '' });
      createNotification({ type: 'INFO', title: 'c', message: '' });
    });

    it('counts only unread', () => {
      expect(getUnreadCount()).toBe(3);
    });

    it('markAsRead reduces unread count', () => {
      const all = getNotifications();
      markAsRead(all[0].id);
      expect(getUnreadCount()).toBe(2);
    });

    it('markAllAsRead drops unread to zero', () => {
      markAllAsRead();
      expect(getUnreadCount()).toBe(0);
    });
  });

  describe('deleteNotification', () => {
    it('removes a single row by id', () => {
      const id1 = createNotification({ type: 'INFO', title: 'keep', message: '' });
      const id2 = createNotification({ type: 'INFO', title: 'gone', message: '' });

      deleteNotification(id2);

      const remaining = getNotifications();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(id1);
    });
  });

  describe('deleteAllNotifications (v4.7.1)', () => {
    it('returns the number of deleted rows', () => {
      createNotification({ type: 'INFO', title: 'a', message: '' });
      createNotification({ type: 'INFO', title: 'b', message: '' });
      createNotification({ type: 'INFO', title: 'c', message: '' });

      const deleted = deleteAllNotifications();
      expect(deleted).toBe(3);
      expect(getNotifications()).toHaveLength(0);
      expect(getUnreadCount()).toBe(0);
    });

    it('returns 0 on an empty table', () => {
      const deleted = deleteAllNotifications();
      expect(deleted).toBe(0);
    });

    it('also clears already-read notifications', () => {
      createNotification({ type: 'INFO', title: 'unread', message: '' });
      const id = createNotification({ type: 'INFO', title: 'read', message: '' });
      markAsRead(id);

      const deleted = deleteAllNotifications();
      expect(deleted).toBe(2);
    });
  });
});
