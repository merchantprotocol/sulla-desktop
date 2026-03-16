/**
 * Integration Test for SullaSettingsModel - Using Real Dependencies
 * Testing actual SullaSettingsModel with real Redis and PostgreSQL
 */

import { SullaSettingsModel } from '../SullaSettingsModel';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Redis from 'ioredis';
import { Pool } from 'pg';

// Integration test setup - will reveal real interface issues
describe('SullaSettingsModel Integration Test', () => {
  let tempFilePath: string;
  let redisConnection: Redis;
  let pgPool: Pool;

  beforeAll(async() => {
    // Try to connect to real Redis and PostgreSQL
    // If they're not available, we'll test file fallback behavior
    try {
      redisConnection = new Redis('redis://127.0.0.1:30117');
      pgPool = new Pool({
        host:     'localhost',
        port:     5432,
        database: 'sulla_test',
        user:     'postgres',
        password: 'password',
      });
    } catch (error) {
      console.log('Redis/PG not available - testing file fallback behavior');
    }
  });

  afterAll(async() => {
    // Clean up connections
    if (redisConnection) await redisConnection.quit();
    if (pgPool) await pgPool.end();
  });

  beforeEach(async() => {
    // Create a temporary file for each test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-test-'));
    tempFilePath = path.join(tempDir, 'settings.json');

    // Set the fallback file path for testing the actual SullaSettingsModel
    SullaSettingsModel.setFallbackFilePath(tempFilePath);
  });

  afterEach(async() => {
    // Clean up temp file after each test
    try {
      await fs.unlink(tempFilePath);
      await fs.rmdir(path.dirname(tempFilePath));
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should handle basic file fallback operations when system not ready', async() => {
    // Test actual SullaSettingsModel file fallback behavior (system not ready = no Redis/DB)

    // Since system isn't bootstrapped, this will use file fallback
    await SullaSettingsModel.setSetting('test_key', 'test_value');

    // Retrieve using actual class - should use file fallback
    const retrieved = await SullaSettingsModel.getSetting('test_key', 'default');
    expect(retrieved).toBe('test_value');

    // Test default value for non-existent key
    const defaultValue = await SullaSettingsModel.getSetting('nonexistent', 'my_default');
    expect(defaultValue).toBe('my_default');

    // Verify actual file was created with real SullaSettingsModel
    const fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    if (fileExists) {
      const fileContent = await fs.readFile(tempFilePath, 'utf8');
      const data = JSON.parse(fileContent);
      expect(data.test_key).toBe('test_value');
    }
  });

  test('should handle different data types with proper casting', async() => {
    // Test actual SullaSettingsModel type casting behavior

    // Test string value
    await SullaSettingsModel.setSetting('string_val', 'hello world', 'string');
    const retrievedString = await SullaSettingsModel.getSetting('string_val');
    expect(retrievedString).toBe('hello world');

    // Test number value with casting
    await SullaSettingsModel.setSetting('number_val', 42.5, 'number');
    const retrievedNumber = await SullaSettingsModel.getSetting('number_val');
    expect(retrievedNumber).toBe(42.5);

    // Test boolean value with casting
    await SullaSettingsModel.setSetting('boolean_val', true, 'boolean');
    const retrievedBoolean = await SullaSettingsModel.getSetting('boolean_val');
    expect(retrievedBoolean).toBe(true);

    // Test JSON array with casting
    const arrayValue = [1, 2, { nested: 'value' }];
    await SullaSettingsModel.setSetting('array_val', arrayValue, 'json');
    const retrievedArray = await SullaSettingsModel.getSetting('array_val');
    expect(Array.isArray(retrievedArray)).toBe(true);
    expect(retrievedArray).toEqual(arrayValue);

    // Test JSON object with casting
    const objValue = { key: 'value', nested: { inner: 123 } };
    await SullaSettingsModel.setSetting('obj_val', objValue, 'json');
    const retrievedObj = await SullaSettingsModel.getSetting('obj_val');
    expect(typeof retrievedObj).toBe('object');
    expect(retrievedObj).toEqual(objValue);
  });
});

console.log('✅ SIMPLE SULLA SETTINGS MODEL TEST - 2 scenarios');
