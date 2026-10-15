import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { createImageStorage, isProductImageUrl } from '../src/images.js';
import { readConfig } from '../src/config.js';

const config = { AWS_REGION: 'ap-south-1', S3_BUCKET: 'fresh-me-test', S3_KEY_PREFIX: 'fresh-me/products' };
const filename = 'f944787a-9713-41a4-965f-51574333d0dc.webp';
const png = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: '#ffc400' } }).png().toBuffer();

describe('private S3 product images', () => {
  it('validates and resizes image bytes, writes unique prefix-scoped keys without ACLs, and returns stable API URLs', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    const storage = createImageStorage(config, client);
    const urls = await Promise.all([storage.upload(await png()), storage.upload(await png())]);
    expect(urls.every(isProductImageUrl)).toBe(true);
    expect(new Set(urls).size).toBe(2);
    const object = client.send.mock.calls[0][0].input;
    expect(object.Bucket).toBe(config.S3_BUCKET);
    expect(urls.map(url => `${config.S3_KEY_PREFIX}/${url.split('/').pop()}`)).toContain(object.Key);
    expect(object.ACL).toBeUndefined();
    expect(object.ContentType).toBe('image/webp');
    expect(object.CacheControl).toContain('immutable');
    const metadata = await sharp(object.Body).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(480);
    expect(metadata.exif).toBeUndefined();
  });

  it('rejects corrupt bytes, SVG and oversized pixel dimensions before calling S3', async () => {
    const client = { send: vi.fn() };
    const storage = createImageStorage(config, client);
    const oversized = await sharp({ create: { width: 5000, height: 4100, channels: 3, background: '#fff' } }).png().toBuffer();
    for (const bytes of [Buffer.from('not an image'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'), oversized]) {
      await expect(storage.upload(bytes)).rejects.toMatchObject({ status: 400 });
    }
    expect(client.send).not.toHaveBeenCalled();
  });

  it('reads only generated filenames from the configured prefix and blocks arbitrary bucket keys', async () => {
    const bytes = Buffer.from('stored-webp-bytes');
    const client = { send: vi.fn().mockResolvedValue({ ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes } }) };
    const storage = createImageStorage(config, client);
    for (const name of ['../other-project/private.png', 'other-project/file.webp', `%2e%2e%2f${filename}`, `${filename}?key=other`, 'photo.svg']) {
      await expect(storage.read(name)).rejects.toMatchObject({ status: 404 });
    }
    expect(client.send).not.toHaveBeenCalled();
    expect(await storage.read(filename)).toEqual(bytes);
    expect(client.send.mock.calls[0][0].input).toEqual({ Bucket: config.S3_BUCKET, Key: `${config.S3_KEY_PREFIX}/${filename}` });
    expect(isProductImageUrl(`/api/images/${filename}`)).toBe(true);
    for (const url of [`https://evil.test/api/images/${filename}`, `/api/images/../${filename}`, `/api/images/${filename}?x=1`]) expect(isProductImageUrl(url)).toBe(false);
  });

  it('returns safe errors on storage failures and distinguishes missing images', async () => {
    const client = { send: vi.fn().mockRejectedValue(Object.assign(new Error('sensitive AWS diagnostic'), { name: 'AccessDenied' })) };
    const storage = createImageStorage(config, client);
    await expect(storage.upload(await png())).rejects.toMatchObject({ status: 503, code: 'S3_UPLOAD_FAILED', message: 'Image storage is unavailable. Please try again.' });
    await expect(storage.read(filename)).rejects.toMatchObject({ status: 503, code: 'S3_READ_FAILED' });
    client.send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    await expect(storage.read(filename)).rejects.toMatchObject({ status: 404 });
  });
});

describe('S3 environment configuration', () => {
  const environment = {
    ...config, NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.test/postgres',
    JWT_SECRET: 'j'.repeat(32), AGENT_KEY: 'a'.repeat(32), RAZORPAY_KEY_ID: 'rzp_live_valid',
    RAZORPAY_KEY_SECRET: 'api-secret', RAZORPAY_WEBHOOK_SECRET: 's'.repeat(32),
    ADMIN_EMAIL: 'owner@shop.test', ADMIN_PASSWORD: 'Strong-test-only-92!', CLIENT_ORIGIN: 'https://orders.shop.test'
  };

  it('supports an IAM role or a complete explicit AWS credential pair without Cloudinary', () => {
    expect(readConfig(environment).S3_BUCKET).toBe(config.S3_BUCKET);
    expect(() => readConfig({ ...environment, AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' })).not.toThrow();
    expect(() => readConfig({ ...environment, AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_SESSION_TOKEN: 'test-token' })).not.toThrow();
  });

  it('rejects partial credentials, missing bucket, unsafe prefix, and non-regional values', () => {
    expect(() => readConfig({ ...environment, AWS_ACCESS_KEY_ID: 'test-key' })).toThrow('both');
    expect(() => readConfig({ ...environment, AWS_SECRET_ACCESS_KEY: 'test-secret' })).toThrow('both');
    expect(() => readConfig({ ...environment, AWS_SESSION_TOKEN: 'test-token' })).toThrow('requires');
    expect(() => readConfig({ ...environment, S3_BUCKET: undefined })).toThrow('S3_BUCKET');
    expect(() => readConfig({ ...environment, S3_KEY_PREFIX: '../other-project' })).toThrow('S3_KEY_PREFIX');
    expect(() => readConfig({ ...environment, S3_KEY_PREFIX: '' })).toThrow('S3_KEY_PREFIX');
    expect(() => readConfig({ ...environment, AWS_REGION: 'Mumbai' })).toThrow('AWS_REGION');
  });
});
