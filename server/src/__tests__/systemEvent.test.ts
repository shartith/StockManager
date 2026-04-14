/**
 * v4.7.1: systemEvent CRUD + bulk delete
 *
 * Verifies the deleteEvent / deleteAllEvents helpers added in v4.7.1.
 * Uses an in-memory better-sqlite3 instance for full isolation.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Disable MLX-based AI advice during tests so logSystemEvent doesn't
// try to call out to a non-existent LLM (severity > INFO triggers it).
vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    mlxEnabled: false,
    mlxUrl: '',
    mlxModel: '',
  })),
}));

// Use an in-memory better-sqlite3 instance to keep tests isolated from
// the production stock-manager.db file.
process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, queryAll, queryOne, execute } from '../db';
// queryAll is used by the audit-log assertion in the v4.7.3 test below.
import {
  logSystemEvent,
  getRecentEvents,
  getUnresolvedEvents,
  resolveEvent,
  deleteEvent,
  deleteAllEvents,
  getEventCounts,
} from '../services/systemEvent';

describe('systemEvent CRUD', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    // Clean slate for each test
    execute('DELETE FROM system_events');
  });

  describe('logSystemEvent + getRecentEvents', () => {
    it('inserts an event and returns it via getRecentEvents', async () => {
      await logSystemEvent('INFO', 'GENERAL', 'test event', 'detail text');

      const rows = getRecentEvents(10);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('test event');
      expect(rows[0].severity).toBe('INFO');
      expect(rows[0].category).toBe('GENERAL');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await logSystemEvent('INFO', 'GENERAL', `event ${i}`);
      }
      const rows = getRecentEvents(3);
      expect(rows).toHaveLength(3);
    });
  });

  describe('resolveEvent + getUnresolvedEvents', () => {
    it('only returns unresolved events', async () => {
      const id1 = await logSystemEvent('WARN', 'GENERAL', 'unresolved');
      const id2 = await logSystemEvent('WARN', 'GENERAL', 'resolved');

      resolveEvent(id2, 'manual fix');

      const unresolved = getUnresolvedEvents(10);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].id).toBe(id1);
      expect(unresolved[0].title).toBe('unresolved');
    });
  });

  describe('deleteEvent (v4.7.1)', () => {
    it('removes a single event by id', async () => {
      const id1 = await logSystemEvent('INFO', 'GENERAL', 'keep me');
      const id2 = await logSystemEvent('INFO', 'GENERAL', 'delete me');

      const deleted = deleteEvent(id2);
      expect(deleted).toBe(1);

      const rows = getRecentEvents(10);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id1);
    });

    it('returns 0 when the id does not exist', async () => {
      const deleted = deleteEvent(99999);
      expect(deleted).toBe(0);
    });
  });

  describe('deleteAllEvents (v4.7.1)', () => {
    beforeEach(async () => {
      await logSystemEvent('INFO', 'GENERAL', 'event 1');
      await logSystemEvent('WARN', 'LLM_DOWN', 'event 2');
      await logSystemEvent('ERROR', 'KIS_API_ERROR', 'event 3');
      // Resolve one of them
      const rows = getRecentEvents(10);
      const middle = rows.find(r => r.title === 'event 2');
      if (middle) resolveEvent(middle.id, 'fixed');
    });

    it('deletes ALL events when onlyResolved=false (default)', () => {
      const deleted = deleteAllEvents();
      expect(deleted).toBe(3);
      expect(getRecentEvents(10)).toHaveLength(0);
    });

    it('deletes only resolved events when onlyResolved=true', () => {
      const deleted = deleteAllEvents(true);
      expect(deleted).toBe(1); // only event 2 was resolved

      const remaining = getRecentEvents(10);
      expect(remaining).toHaveLength(2);
      expect(remaining.map(r => r.title).sort()).toEqual(['event 1', 'event 3']);
    });

    it('returns 0 on an empty table', () => {
      execute('DELETE FROM system_events'); // wipe first
      execute('DELETE FROM audit_log');     // also clean audit between tests
      const deleted = deleteAllEvents();
      expect(deleted).toBe(0);
    });

    // v4.7.3: audit log entry is written for every bulk delete
    it('writes an audit_log row capturing bulk delete metadata', () => {
      execute('DELETE FROM audit_log'); // start clean

      deleteAllEvents();

      const auditRows = queryAll(
        "SELECT * FROM audit_log WHERE entity_type = 'system_events' AND action = 'DELETE'",
      );
      expect(auditRows).toHaveLength(1);
      const newValue = JSON.parse(auditRows[0].new_value);
      expect(newValue.bulk).toBe(true);
      expect(newValue.onlyResolved).toBe(false);
      expect(newValue.deleted).toBe(3);
    });

    it('audit log captures critical-deleted count when not onlyResolved', async () => {
      execute('DELETE FROM system_events');
      execute('DELETE FROM audit_log');
      await logSystemEvent('CRITICAL', 'STOP_LOSS', 'crit unresolved');
      await logSystemEvent('INFO', 'GENERAL', 'info');

      deleteAllEvents();

      const audit = queryOne(
        "SELECT new_value FROM audit_log WHERE entity_type = 'system_events' AND action = 'DELETE' ORDER BY id DESC LIMIT 1",
      );
      const meta = JSON.parse(audit!.new_value);
      expect(meta.criticalDeleted).toBe(1);
      expect(meta.deleted).toBe(2);
    });
  });

  describe('getEventCounts', () => {
    it('counts severity buckets correctly', async () => {
      await logSystemEvent('INFO', 'GENERAL', 'info 1');
      await logSystemEvent('WARN', 'LLM_DOWN', 'warn 1');
      await logSystemEvent('WARN', 'LLM_DOWN', 'warn 2');
      await logSystemEvent('ERROR', 'KIS_API_ERROR', 'err 1');
      await logSystemEvent('CRITICAL', 'STOP_LOSS', 'crit 1');

      const counts = getEventCounts();
      expect(counts.warn).toBe(2);
      expect(counts.error).toBe(1);
      expect(counts.critical).toBe(1);
      expect(counts.unresolved).toBe(5);
    });

    it('excludes resolved events from severity buckets', async () => {
      const id = await logSystemEvent('ERROR', 'KIS_API_ERROR', 'will resolve');
      resolveEvent(id, 'fixed');

      const counts = getEventCounts();
      expect(counts.error).toBe(0);
      expect(counts.unresolved).toBe(0);
    });
  });
});
