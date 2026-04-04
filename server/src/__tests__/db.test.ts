import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock fs to prevent actual file writes from saveDB
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { initializeDB, queryAll, queryOne, execute, withTransaction, logAudit, getDB } from '../db';

describe('db helper functions', () => {
  beforeAll(async () => {
    // Initialize a real in-memory sql.js database
    await initializeDB();
  });

  describe('queryAll', () => {
    it('returns empty array when no rows match', () => {
      const results = queryAll("SELECT * FROM stocks WHERE ticker = 'NONEXISTENT'");
      expect(results).toEqual([]);
    });

    it('returns array of row objects', () => {
      execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_TEST1', 'Test Stock 1', 'KRX']);
      const results = queryAll("SELECT ticker, name FROM stocks WHERE ticker = 'QA_TEST1'");
      expect(results).toHaveLength(1);
      expect(results[0].ticker).toBe('QA_TEST1');
      expect(results[0].name).toBe('Test Stock 1');
    });

    it('returns multiple rows', () => {
      execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_TEST2', 'Test Stock 2', 'KRX']);
      execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_TEST3', 'Test Stock 3', 'KRX']);
      const results = queryAll("SELECT * FROM stocks WHERE ticker LIKE 'QA_TEST%' ORDER BY ticker");
      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it('supports parameterized queries', () => {
      const results = queryAll('SELECT * FROM stocks WHERE ticker = ? AND market = ?', ['QA_TEST1', 'KRX']);
      expect(results).toHaveLength(1);
    });

    it('returns empty array with empty params', () => {
      const results = queryAll('SELECT * FROM stocks WHERE 1 = 0');
      expect(results).toEqual([]);
    });
  });

  describe('queryOne', () => {
    it('returns single row object', () => {
      const row = queryOne("SELECT ticker, name FROM stocks WHERE ticker = 'QA_TEST1'");
      expect(row).not.toBeNull();
      expect(row.ticker).toBe('QA_TEST1');
    });

    it('returns null when no match', () => {
      const row = queryOne("SELECT * FROM stocks WHERE ticker = 'DOESNOTEXIST'");
      expect(row).toBeNull();
    });

    it('returns first row when multiple match', () => {
      const row = queryOne("SELECT * FROM stocks WHERE ticker LIKE 'QA_TEST%' ORDER BY ticker ASC");
      expect(row).not.toBeNull();
      expect(row.ticker).toBe('QA_TEST1');
    });
  });

  describe('execute', () => {
    it('inserts a row and returns lastId', () => {
      const result = execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_EXEC1', 'Exec Test', 'NYSE']);
      expect(result.lastId).toBeGreaterThan(0);
    });

    it('updates rows and returns changes count', () => {
      execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_UPD1', 'Update Test', 'KRX']);
      const result = execute("UPDATE stocks SET name = 'Updated Name' WHERE ticker = 'QA_UPD1'");
      expect(result.changes).toBe(1);
    });

    it('deletes rows and returns changes count', () => {
      execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_DEL1', 'Delete Test', 'KRX']);
      const result = execute("DELETE FROM stocks WHERE ticker = 'QA_DEL1'");
      expect(result.changes).toBe(1);
    });

    it('returns 0 changes when no rows affected', () => {
      const result = execute("DELETE FROM stocks WHERE ticker = 'NONEXISTENT_TICKER'");
      expect(result.changes).toBe(0);
    });
  });

  describe('withTransaction', () => {
    it('commits on success and persists data', () => {
      // Use raw db.run instead of execute to avoid saveDB calling db.export mid-transaction
      const db = getDB();
      const result = withTransaction(() => {
        db.run('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_TX1', 'TX Test', 'KRX']);
        return 'success';
      });

      expect(result).toBe('success');
      const row = queryOne("SELECT * FROM stocks WHERE ticker = 'QA_TX1'");
      expect(row).not.toBeNull();
      expect(row.name).toBe('TX Test');
    });

    it('rolls back on error', () => {
      const db = getDB();
      expect(() =>
        withTransaction(() => {
          db.run('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['QA_TX2', 'Rollback Test', 'KRX']);
          throw new Error('intentional error');
        })
      ).toThrow('intentional error');

      const row = queryOne("SELECT * FROM stocks WHERE ticker = 'QA_TX2'");
      expect(row).toBeNull();
    });

    it('returns the value from the callback', () => {
      const result = withTransaction(() => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it('propagates the error from the callback', () => {
      const db = getDB();
      expect(() =>
        withTransaction(() => {
          throw new TypeError('type error');
        })
      ).toThrow(TypeError);
    });
  });

  describe('logAudit', () => {
    it('inserts an audit record with all fields', () => {
      logAudit('STOCK', 1, 'CREATE', null, { ticker: 'AUDIT1', name: 'Audit Test' });

      const row = queryOne(
        "SELECT * FROM audit_log WHERE entity_type = 'STOCK' AND entity_id = 1 AND action = 'CREATE' ORDER BY id DESC"
      );
      expect(row).not.toBeNull();
      expect(row.entity_type).toBe('STOCK');
      expect(row.entity_id).toBe(1);
      expect(row.action).toBe('CREATE');
      expect(row.old_value).toBeNull();
      expect(JSON.parse(row.new_value)).toEqual({ ticker: 'AUDIT1', name: 'Audit Test' });
    });

    it('stores old_value as JSON when provided', () => {
      logAudit('STOCK', 2, 'UPDATE', { name: 'Old Name' }, { name: 'New Name' });

      const row = queryOne(
        "SELECT * FROM audit_log WHERE entity_type = 'STOCK' AND entity_id = 2 AND action = 'UPDATE' ORDER BY id DESC"
      );
      expect(row).not.toBeNull();
      expect(JSON.parse(row.old_value)).toEqual({ name: 'Old Name' });
      expect(JSON.parse(row.new_value)).toEqual({ name: 'New Name' });
    });

    it('handles null entity_id', () => {
      logAudit('SYSTEM', null, 'CREATE', undefined, { event: 'startup' });

      const row = queryOne(
        "SELECT * FROM audit_log WHERE entity_type = 'SYSTEM' ORDER BY id DESC"
      );
      expect(row).not.toBeNull();
      expect(row.entity_id).toBeNull();
      expect(row.old_value).toBeNull();
    });

    it('handles DELETE action with old_value only', () => {
      logAudit('STOCK', 3, 'DELETE', { ticker: 'DEL1' }, undefined);

      const row = queryOne(
        "SELECT * FROM audit_log WHERE entity_type = 'STOCK' AND entity_id = 3 AND action = 'DELETE' ORDER BY id DESC"
      );
      expect(row).not.toBeNull();
      expect(JSON.parse(row.old_value)).toEqual({ ticker: 'DEL1' });
      expect(row.new_value).toBeNull();
    });
  });

  describe('getDB', () => {
    it('returns the database instance', () => {
      const db = getDB();
      expect(db).toBeDefined();
      expect(typeof db.run).toBe('function');
      expect(typeof db.prepare).toBe('function');
    });
  });
});
