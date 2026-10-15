import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { testDatabase, resetDatabase } from './database-helper.js';
import { database } from '../src/database.js';

import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { Order, Product, Counter, PrintJob, Admin, Settings, Refund } from '../src/models.js';
import { calculateOrder, createOrder, finalizePayment, expireOrders, orderInput } from '../src/payments.js';
import { claimJobs } from '../src/agent-api.js';
import { validSignature, istDate, csvCell } from '../src/utils.js';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { readConfig } from '../src/config.js';
import { createGateway } from '../src/gateway.js';
import sharp from 'sharp';
import { createImageStorage } from '../src/images.js';
let db, app, product, gateway;
const config = { NODE_ENV: 'test', TRUST_PROXY: 0, CLIENT_ORIGIN: 'http://localhost:5173', JWT_SECRET: 'j'.repeat(32), AGENT_KEY: 'a'.repeat(32), RAZORPAY_KEY_ID: 'rzp_test_unit', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'webhook-secret', AWS_REGION: 'ap-south-1', S3_BUCKET: 'fresh-me-test', S3_KEY_PREFIX: 'fresh-me/products' };
const sign = (data, secret = config.RAZORPAY_WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const input = () => ({ idempotencyKey: crypto.randomUUID(), phone: '9876543210', customerName: 'Test', items: [{ productId: String(product._id), size: 'Small', qty: 2 }] });
beforeAll(async () => { db = await testDatabase(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetDatabase();
  await Settings.updateOne({ _id: 'shop' }, { $set: { acceptingOrders: true } });
  product = await Product.create({ name: 'Mango', category: 'Fruit', flavorColor: '#ffbb22', sizes: [{ label: 'Small', price: 40 }], available: true });
  gateway = { orders: { create: vi.fn(async ({ amount, receipt }) => ({ id: `order_${receipt}`, amount })), all: vi.fn(async () => ({ items: [] })), fetch: vi.fn() }, payments: { fetch: vi.fn() } };
  app = createApp({ config, gateway, logger: { info() {}, error() {} } });
});
async function pending() { const result = await createOrder(input(), gateway, config); return { result, payment: { id: `pay_${result.orderId}`, order_id: result.razorpayOrderId, amount: 8000, currency: 'INR', status: 'captured', method: 'upi' } }; }
describe('payment correctness', () => {
  it('uses database prices and rejects forged prices, unavailable products and sizes', async () => {
    expect((await calculateOrder(input())).total).toBe(80);
    expect(() => orderInput.parse({ ...input(), total: 1 })).toThrow();
    const bad = input(); bad.items[0].unitPrice = 1; expect(() => orderInput.parse(bad)).toThrow();
    const size = input(); size.items[0].size = 'Giant'; await expect(calculateOrder(size)).rejects.toThrow();
    await Product.updateOne({ _id: product._id }, { available: false }); await expect(calculateOrder(input())).rejects.toThrow();
  });
  it('validates signatures and IST midnight', () => {
    const message = 'order_test|pay_test'; expect(validSignature(message, sign(message, 'secret'), 'secret')).toBe(true);
    expect(validSignature(message, 'invalid', 'secret')).toBe(false); expect(validSignature('tampered', sign(message), config.RAZORPAY_WEBHOOK_SECRET)).toBe(false);
    expect(istDate(new Date('2026-01-01T18:30:00Z'))).toBe('2026-01-02');
    expect(csvCell('  =HYPERLINK("bad")')).toMatch(/^"'/);
  });
  it('creates the same local and gateway order under concurrent retries', async () => {
    const body = input(); const results = await Promise.all(Array.from({ length: 8 }, () => createOrder(body, gateway, config)));
    expect(new Set(results.map(r => r.orderId)).size).toBe(1); expect(await Order.countDocuments()).toBe(1); expect(gateway.orders.create).toHaveBeenCalledTimes(1);
    expect(await PrintJob.countDocuments()).toBe(0); expect(await Counter.countDocuments()).toBe(0);
    await expect(createOrder({ ...body, phone: '9123456789' }, gateway, config)).rejects.toThrow('different cart');
  });
  it('does not blindly repeat a gateway create after an ambiguous failure', async () => {
    const body = input(); gateway.orders.create.mockRejectedValue(new Error('timeout'));
    await expect(createOrder(body, gateway, config)).rejects.toThrow();
    await expect(createOrder(body, gateway, config)).rejects.toThrow();
    expect(gateway.orders.create).toHaveBeenCalledTimes(1);
  });
  it('allocates one token and one print job when verify and webhook race', async () => {
    const { result, payment } = await pending(); gateway.payments.fetch.mockResolvedValue(payment);
    const webhook = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: payment } } });
    const verify = { orderId: result.orderId, razorpayOrderId: result.razorpayOrderId, paymentId: payment.id, signature: sign(`${result.razorpayOrderId}|${payment.id}`, config.RAZORPAY_KEY_SECRET) };
    const responses = await Promise.all([request(app).post('/api/payments/verify').send(verify), ...Array.from({ length: 6 }, () => request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sign(webhook)).send(webhook))]);
    expect(responses.map(r => ({ status: r.status, body: r.body })).filter(r => r.status !== 200)).toEqual([]);
    const paid = await Order.findById(result.orderId); expect(paid.status).toBe('PAID'); expect(paid.tokenNo).toBe(1); expect((await Counter.findById(istDate())).seq).toBe(1); expect(await PrintJob.countDocuments()).toBe(1);
    const publicResponse = await request(app).get(`/api/orders/${result.orderId}`); expect(publicResponse.body.phone).toBeUndefined(); expect(publicResponse.body.customerName).toBeUndefined();
  });
  it('allocates unique sequential tokens for separate concurrent orders', async () => {
    const pairs = await Promise.all(Array.from({ length: 6 }, () => pending())); await Promise.all(pairs.map(p => finalizePayment(p.payment)));
    expect((await Order.find().sort({ tokenNo: 1 })).map(o => o.tokenNo)).toEqual([1,2,3,4,5,6]);
  });
  it('rejects bad amount and uncaptured funds without issuing a token', async () => {
    const { payment } = await pending(); await expect(finalizePayment({ ...payment, amount: 1 })).rejects.toThrow('amount'); await expect(finalizePayment({ ...payment, status: 'authorized' })).rejects.toThrow('capture'); expect(await PrintJob.countDocuments()).toBe(0);
  });
  it('expires unpaid orders and fulfils a late captured payment', async () => {
    const { result, payment } = await pending(); await Order.updateOne({ _id: result.orderId }, { $set: { createdAt: new Date(Date.now() - 1900000) } });
    await expireOrders(); expect((await Order.findById(result.orderId)).status).toBe('EXPIRED'); await finalizePayment(payment); expect((await Order.findById(result.orderId)).status).toBe('PAID');
  });
  it('rolls back payment, both counters and status when print insertion fails', async () => {
    const { result, payment } = await pending();
    const spy = vi.spyOn(PrintJob, 'create').mockRejectedValueOnce(new Error('injected storage failure'));
    try { await expect(finalizePayment(payment)).rejects.toThrow('injected storage failure'); }
    finally { spy.mockRestore(); }
    expect((await Order.findById(result.orderId)).status).toBe('PENDING_PAYMENT');
    expect(await Counter.countDocuments()).toBe(0);
    expect(await PrintJob.countDocuments()).toBe(0);
    await finalizePayment(payment);
    expect((await Order.findById(result.orderId)).tokenNo).toBe(1);
    expect(await PrintJob.countDocuments()).toBe(1);
  });
  it('handles order.paid, raw signature tampering, failure and refund webhooks', async () => {
    const { result, payment } = await pending();
    const emit = async (event, payload) => { const raw = JSON.stringify({ event, payload }); return request(app).post('/api/webhooks/razorpay').set('Content-Type','application/json').set('x-razorpay-signature', sign(raw)).send(raw); };
    expect((await emit('payment.failed', {})).status).toBe(200); expect((await Order.findById(result.orderId)).status).toBe('PENDING_PAYMENT');
    expect((await emit('refund.processed', { refund: { entity: { id: 'rfnd_1', payment_id: payment.id } } })).status).toBe(200);
    expect((await emit('order.paid', { payment: { entity: payment } })).status).toBe(200); expect((await Order.findById(result.orderId)).refunded).toBe(true);
    expect((await request(app).post('/api/webhooks/razorpay').set('x-razorpay-signature', sign('{}')).send({ event: 'tampered' })).status).toBe(401);
  });
});
describe('PostgreSQL deployment', () => {
  it('migrations and concurrent seeds are repeatable without resetting passwords', async () => {
    await Promise.all([migrate(), migrate()]);
    const settings = { ADMIN_EMAIL: 'seed@example.com', ADMIN_PASSWORD: 'Seed-test-only-17!' };
    await Promise.all([seed(settings), seed(settings)]);
    expect(await Admin.countDocuments({ email: settings.ADMIN_EMAIL })).toBe(1);
    const before = await Admin.findOne({ email: settings.ADMIN_EMAIL });
    await seed({ ...settings, ADMIN_PASSWORD: 'Changed-seed-only-19!' });
    expect((await Admin.findById(before._id)).passwordHash).toBe(before.passwordHash);
    expect(await Product.countDocuments()).toBe(6);
  });
  it('menu-only seed preserves existing products and does not create an admin', async () => {
    await seed({}, { menuOnly: true });
    await seed({}, { menuOnly: true });
    expect(await Product.countDocuments({})).toBe(6);
    expect(await Admin.countDocuments({})).toBe(0);
    expect((await Product.findById(product._id)).sizes[0].price).toBe(40);
  });
  it('health checks query PostgreSQL and reports are served by SQL', async () => {
    const { payment } = await pending(); await finalizePayment(payment);
    expect((await request(app).get('/healthz')).body).toEqual({ ok: true });
    await Admin.create({ email: 'report@example.com', passwordHash: await bcrypt.hash('Report-test-only!', 4) });
    const browser = request.agent(app);
    await browser.post('/api/admin/login').send({ email: 'report@example.com', password: 'Report-test-only!' });
    const dashboard = await browser.get('/api/admin/dashboard');
    expect(dashboard.status).toBe(200); expect(dashboard.body.revenue).toBe(80);
    const csv = await browser.get('/api/admin/payments.csv');
    expect(csv.status).toBe(200); expect(csv.text).toContain('"80"');
  });
  it('rejects production demo payments, insecure TLS and placeholder service credentials', () => {
    const production = { ...config, NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.example.com/postgres', CLIENT_ORIGIN: 'https://orders.example.com', RAZORPAY_KEY_ID: 'rzp_live_valid', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'Strong-test-only-92!', RAZORPAY_WEBHOOK_SECRET: 's'.repeat(32) };
    expect(() => readConfig(production)).not.toThrow();
    expect(() => readConfig({ ...production, DEMO_PAYMENT: 'true' })).toThrow('DEMO_PAYMENT');
    expect(() => readConfig({ ...production, DATABASE_SSL: 'disable' })).toThrow('TLS');
    expect(() => readConfig({ ...production, S3_BUCKET: 'replace-me' })).toThrow('placeholder');
    expect(() => createGateway({ ...config, DEMO_PAYMENT: true, DATABASE_URL: production.DATABASE_URL })).toThrow('local development');
    const prodApp = createApp({ config: production, gateway: { isDemo: true }, logger: { error() {} } });
    return request(prodApp).post('/api/payments/demo-confirm').send({}).expect(404);
  });
});
describe('print queue and security', () => {
  it('uploads an authenticated image to private storage, saves it on a product, and serves it publicly with caching', async () => {
    const objects = new Map();
    const send = vi.fn(async command => {
      if (command.input.Body) { objects.set(command.input.Key, command.input.Body); return {}; }
      const bytes = objects.get(command.input.Key);
      return { ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes } };
    });
    const imageApp = createApp({ config, gateway, logger: { error() {}, info() {} }, imageStorage: createImageStorage(config, { send }) });
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#ffaa00' } }).png().toBuffer();
    expect((await request(imageApp).post('/api/admin/products/image').attach('image', bytes, 'mango.png')).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    await Admin.create({ email: 'image@example.com', passwordHash: await bcrypt.hash('Image-test-only!', 4) });
    const browser = request.agent(imageApp);
    await browser.post('/api/admin/login').send({ email: 'image@example.com', password: 'Image-test-only!' });
    const uploaded = await browser.post('/api/admin/products/image').attach('image', bytes, 'mango.png');
    expect(uploaded.status).toBe(200);
    const image = await request(imageApp).get(uploaded.body.imageUrl);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toContain('image/webp');
    expect(image.headers['cache-control']).toContain('immutable');
    expect((await sharp(image.body).metadata()).format).toBe('webp');
    const body = { name: 'S3 Mango', category: 'Fruit', flavorColor: '#ffaa00', sizes: [{ label: 'Small', price: 40 }], imageUrl: uploaded.body.imageUrl, available: true, sortOrder: 0 };
    expect((await browser.post('/api/admin/products').send(body)).status).toBe(201);
    expect((await request(imageApp).get('/api/menu')).body.products.some(p => p.imageUrl === body.imageUrl)).toBe(true);
    expect((await browser.post('/api/admin/products').send({ ...body, imageUrl: 'https://evil.test/image.webp' })).status).toBe(400);
    expect((await browser.post('/api/admin/products/image').attach('image', Buffer.from('fake image'), 'fake.png')).status).toBe(400);
    expect((await browser.post('/api/admin/products/image').attach('image', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png')).status).toBe(413);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('atomically claims jobs and reclaims only stale PRINTING jobs', async () => {
    await PrintJob.create(Array.from({ length: 10 }, () => ({ type: 'TEST', payload: { createdAt: new Date(), items: [] } })));
    const batches = await Promise.all([claimJobs(), claimJobs(), claimJobs()]); const ids = batches.flat().map(j => String(j._id)); expect(ids.length).toBe(10); expect(new Set(ids).size).toBe(10);
    expect(await claimJobs()).toHaveLength(0); await PrintJob.updateOne({ _id: ids[0] }, { claimedAt: new Date(Date.now() - 61000) }); const reclaimed = await claimJobs(); expect(reclaimed).toHaveLength(1); expect(String(reclaimed[0]._id)).toBe(ids[0]);
  });
  it('rejects missing or incorrect agent keys and records heartbeat', async () => {
    expect((await request(app).get('/api/agent/jobs')).status).toBe(401); expect((await request(app).get('/api/agent/jobs').set('x-agent-key', 'wrong')).status).toBe(401);
    expect((await request(app).get('/api/agent/jobs?printer=online').set('x-agent-key',config.AGENT_KEY)).status).toBe(200); expect((await Settings.findById('shop')).agentPrinterStatus).toBe('online');
  });
  it('fails after five attempts, makes reports idempotent and fences stale claims', async () => {
    await PrintJob.create({ type: 'TEST' }); let first;
    for (let n = 0; n < 5; n++) {
      const [job] = await claimJobs(); first ||= job;
      const report = () => request(app).post(`/api/agent/jobs/${job._id}/failed`).set('x-agent-key', config.AGENT_KEY).send({ claimId: job.claimId, error: 'Printer offline' });
      expect((await report()).status).toBe(200); expect((await report()).status).toBe(200);
    }
    const failed = await PrintJob.findById(first._id); expect(failed.status).toBe('FAILED'); expect(failed.attempts).toBe(5);
    expect((await request(app).post(`/api/agent/jobs/${first._id}/done`).set('x-agent-key', config.AGENT_KEY).send({ claimId: first.claimId })).status).toBe(409);
  });
  it('requires admin auth, rejects cross-origin mutations and invalidates password sessions', async () => {
    await Admin.create({ email: 'test@example.com', passwordHash: await bcrypt.hash('a-long-password', 4) });
    const browser = request.agent(app); expect((await browser.get('/api/admin/dashboard')).status).toBe(401);
    expect((await browser.post('/api/admin/login').set('Origin','https://evil.example').send({ email: 'test@example.com', password: 'a-long-password' })).status).toBe(403);
    expect((await browser.post('/api/admin/login').send({ email: 'test@example.com', password: 'a-long-password' })).status).toBe(200);
    expect((await browser.get('/api/admin/dashboard')).status).toBe(200);
    expect((await browser.post('/api/admin/change-password').send({ currentPassword: 'a-long-password', newPassword: 'another-long-password' })).status).toBe(200);
    expect((await browser.get('/api/admin/me')).status).toBe(401);
  });
});
