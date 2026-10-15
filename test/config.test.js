import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { readConfig, readDatabaseConfig, readSeedConfig } from '../src/config.js';
import { createEnvironment } from '../scripts/setup-env.js';

const database = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:unit-only@db.test/fresh_me', DATABASE_SSL: 'verify-full' };
describe('independent deployment commands', () => {
  it('database commands work without payment, storage or admin configuration', () => {
    expect(readDatabaseConfig(database).DATABASE_SSL).toBe('verify-full');
    expect(() => readDatabaseConfig({ ...database, DATABASE_SSL: 'disable' })).toThrow('verified TLS');
    expect(() => readDatabaseConfig({ ...database, DATABASE_URL: 'https://db.test' })).toThrow('DATABASE_URL');
    expect(() => readConfig(database)).toThrow('Invalid environment');
  });
  it('seed needs only database plus a real owner login and retains production password checks', () => {
    const env = { ...database, ADMIN_EMAIL: 'owner@freshme.shop', ADMIN_PASSWORD: 'Unit-Only-Seed-91!' };
    expect(readSeedConfig(env).ADMIN_EMAIL).toBe(env.ADMIN_EMAIL);
    expect(() => readSeedConfig({ ...env, ADMIN_EMAIL: 'owner@your-domain.com' })).toThrow('real owner');
    expect(() => readSeedConfig({ ...env, ADMIN_PASSWORD: 'aaaaaaaaaaaa' })).toThrow('strong');
    expect(() => readSeedConfig({ ...env, ADMIN_PASSWORD: 'Replace-This-91!' })).toThrow('placeholder');
  });
  it('environment setup generates independent secrets and never replaces existing credentials', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'freshme-env-'));
    const filename = path.join(directory, '.env');
    try {
      createEnvironment(filename);
      const original = readFileSync(filename, 'utf8');
      const env = dotenv.parse(original);
      expect(env.PORT).toBe('3103');
      expect(env.NODE_ENV).toBe('production');
      expect(new Set([env.JWT_SECRET, env.AGENT_KEY, env.RAZORPAY_WEBHOOK_SECRET]).size).toBe(3);
      expect(env.AGENT_KEY).toMatch(/^[a-f0-9]{64}$/);
      expect(() => readSeedConfig({ ...env, DATABASE_URL: database.DATABASE_URL, ADMIN_EMAIL: 'owner@freshme.shop' })).not.toThrow();
      expect(() => createEnvironment(filename)).toThrow();
      expect(readFileSync(filename, 'utf8')).toBe(original);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
