import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { z, ZodError } from 'zod';
import { databaseHealthy } from './database.js';
import { fileURLToPath } from 'node:url';
import { Product, Settings, Order, PrintJob } from './models.js';
import { orderInput, createOrder, finalizePayment, recordRefund } from './payments.js';
import { asyncRoute, HttpError, validSignature, objectId, publicSettings, isAllowedOrigin } from './utils.js';
import { agentRouter } from './agent-api.js';
import { adminRouter } from './admin.js';
import { createImageStorage, imageCacheControl } from './images.js';
export function createApp({ config, gateway, logger, imageStorage = createImageStorage(config) }) {
  const app = express(); app.set('trust proxy', config.TRUST_PROXY); app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com', 'https://*.razorpay.com', 'https://cdn.razorpay.com'],
        scriptSrcElem: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com', 'https://*.razorpay.com', 'https://cdn.razorpay.com'],
        frameSrc: ["'self'", 'https://checkout.razorpay.com', 'https://api.razorpay.com', 'https://*.razorpay.com'],
        connectSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://*.razorpay.com', 'https://lumberjack.razorpay.com'],
        imgSrc: ["'self'", 'data:', 'https://*.razorpay.com', 'https://cdn.razorpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(cors({
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin, config.CLIENT_ORIGIN, config.NODE_ENV === 'production')),
    credentials: true
  }));
  app.get('/healthz', asyncRoute(async (req, res) => { const ok = await databaseHealthy(); res.status(ok ? 200 : 503).json({ ok }); }));
  app.get('/api/images/:filename', asyncRoute(async (req, res) => {
    const body = await imageStorage.read(req.params.filename);
    res.set('Cache-Control', imageCacheControl).type('image/webp').send(body);
  }));
  app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '256kb' }), asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.get('x-razorpay-signature'), config.RAZORPAY_WEBHOOK_SECRET)) throw new HttpError(401, 'Invalid webhook signature');
    let event; try { event = JSON.parse(req.body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid webhook JSON'); }
    event = z.object({ event: z.string(), payload: z.record(z.unknown()).default({}) }).passthrough().parse(event);
    if (['payment.captured','order.paid'].includes(event.event)) {
      const payment = z.object({ id: z.string().min(1), order_id: z.string().min(1), status: z.literal('captured'), amount: z.number().int().positive(), currency: z.string(), method: z.string().optional() }).passthrough().parse(event.payload.payment?.entity);
      // Reconcile a webhook arriving before the create-order response was stored.
      if (!(await Order.exists({ razorpayOrderId: payment.order_id }))) {
        const remote = await gateway.orders.fetch(payment.order_id);
        if (/^[a-f\d]{24}$/i.test(remote.receipt || '')) await Order.updateOne({ _id: remote.receipt, total: payment.amount / 100, razorpayOrderId: { $exists: false } }, { $set: { razorpayOrderId: payment.order_id } });
      }
      await finalizePayment(payment);
    } else if (event.event === 'refund.processed') {
      await recordRefund(z.object({ id: z.string().min(1), payment_id: z.string().min(1) }).passthrough().parse(event.payload.refund?.entity));
    } else if (event.event === 'payment.failed') logger.info({ event: 'payment.failed' }, 'Payment failed; checkout remains retryable');
    res.json({ ok: true });
  }));
  app.use(express.json({ limit: '64kb' }), cookieParser());
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const publicPost = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please wait one minute.' } });
  app.get('/api/menu', asyncRoute(async (req, res) => {
    const [products, settings] = await Promise.all([Product.find({ deleted: false }).sort({ available: -1, sortOrder: 1 }).lean(), Settings.findById('shop')]);
    res.json({ products, settings: { ...publicSettings(settings), isDemo: Boolean(gateway.isDemo) } });
  }));
  app.post('/api/orders', publicPost, asyncRoute(async (req, res) => res.status(201).json(await createOrder(orderInput.parse(req.body), gateway, config))));
  if (config.NODE_ENV !== 'production' && gateway.isDemo) {
    app.post('/api/payments/demo-confirm', publicPost, asyncRoute(async (req, res) => {
      const body = z.object({ orderId: objectId }).strict().parse(req.body);
      const order = await Order.findById(body.orderId);
      if (!order) throw new HttpError(404, 'Order not found');
      if (!order.razorpayOrderId) throw new HttpError(400, 'Order has no associated gateway ID');
      const paymentId = `pay_demo_${Date.now()}`;
      const payment = { id: paymentId, order_id: order.razorpayOrderId, amount: order.total * 100, currency: 'INR', status: 'captured', method: 'upi' };
      if (gateway.payments?.registerPayment) gateway.payments.registerPayment(payment);
      const paid = await finalizePayment(payment);
      res.json({ orderId: paid._id, orderCode: paid.orderCode, tokenNo: paid.tokenNo, status: paid.status });
    }));
  }
  app.post('/api/payments/verify', publicPost, asyncRoute(async (req, res) => {
    const body = z.object({ orderId: objectId, razorpayOrderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().max(128) }).strict().parse(req.body);
    const order = await Order.findById(body.orderId);
    if (!order || order.razorpayOrderId !== body.razorpayOrderId || !validSignature(`${order.razorpayOrderId}|${body.paymentId}`, body.signature, config.RAZORPAY_KEY_SECRET)) throw new HttpError(400, 'Payment verification failed');
    const payment = await gateway.payments.fetch(body.paymentId);
    if (payment.order_id !== order.razorpayOrderId || payment.id !== body.paymentId) throw new HttpError(400, 'Payment does not belong to this order');
    const paid = await finalizePayment(payment); res.json({ orderId: paid._id, orderCode: paid.orderCode, tokenNo: paid.tokenNo, status: paid.status });
  }));
  app.get('/api/orders/:id', asyncRoute(async (req, res) => {
    const isObjectId = /^[a-f\d]{24}$/i.test(req.params.id);
    const query = isObjectId ? { _id: req.params.id } : { orderCode: req.params.id.toUpperCase() };
    const order = await Order.findOne(query).select('orderCode tokenNo status items total createdAt').lean();
    if (!order) throw new HttpError(404, 'Order not found');
    const latest = await PrintJob.findOne({ orderId: order._id }).sort({ createdAt: -1, _id: -1 });
    res.json({ ...order, orderId: order._id, printed: latest?.status === 'PRINTED' });
  }));
  app.use('/api/agent', agentRouter(config)); app.use('/api/admin', adminRouter(config, imageStorage));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Endpoint not found')));
  const dist = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  app.use(compression(), express.static(dist, { setHeaders(res, path) { if (path.includes('assets')) res.set('Cache-Control', 'public,max-age=31536000,immutable'); else res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
  app.get('*', (req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(`${dist}/index.html`, e => e && next(new HttpError(404, 'Client build missing. Run npm run build.')));
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) logger.error({ name: err.name, code: err.code, path: req.path }, 'Request failed');
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
  });
  return app;
}
