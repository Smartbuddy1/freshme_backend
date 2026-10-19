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
import {publicShop,shopSlug,shopView} from './shops.js';
import { agentRouter } from './agent-api.js';
import { adminRouter } from './admin.js';
import { createImageStorage, imageCacheControl } from './images.js';
export function createApp({ config, gateway, logger, imageStorage = createImageStorage(config) }) {
  const app = express(); app.set('trust proxy', config.TRUST_PROXY); app.disable('x-powered-by');
  app.use(compression());
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
        scriptSrcElem: ["'self'", 'https://checkout.razorpay.com'],
        frameSrc: ["'self'", 'https://checkout.razorpay.com', 'https://api.razorpay.com'],
        connectSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com'],
        imgSrc: ["'self'", 'data:'],
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
  // Separate shared-NAT budgets: payment confirmation cannot be starved by cart requests.
  const limit = maximum => rateLimit({ windowMs: 60000, limit: maximum, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please wait one minute.' } });
  const publicPost = limit(120), paymentPost = limit(300);
  const menuCache=new Map();
  const invalidateMenu=id=>{menuCache.delete(id);};
  app.get('/api/menu',asyncRoute(async(req,res)=>{
    const q=z.object({shopSlug:shopSlug.optional()}).strict().parse(req.query);
    const shop=await publicShop(q.shopSlug);
    let cached=menuCache.get(shop._id);
    if(!cached || Date.now()-cached.time>=10000){
      cached={time:Date.now()};
      cached.products=Promise.resolve(Product.find({shopId:shop._id,deleted:false}).sort({available:-1,sortOrder:1}).lean()).catch(error=>{if(menuCache.get(shop._id)===cached)invalidateMenu(shop._id);throw error;});
      menuCache.set(shop._id,cached);if(menuCache.size>200)menuCache.delete(menuCache.keys().next().value);
    }
    const [products,settings]=await Promise.all([cached.products,Settings.findById(shop._id)]);
    res.json({products,shop:shopView(shop),settings:{...publicSettings(settings),isDemo:Boolean(gateway.isDemo)}});
  }));
  app.post('/api/orders', publicPost, asyncRoute(async (req, res) => res.status(201).json(await createOrder(orderInput.parse(req.body), gateway, config))));
  if (config.NODE_ENV !== 'production' && gateway.isDemo) {
    app.post('/api/payments/demo-confirm', paymentPost, asyncRoute(async (req, res) => {
      const body = z.object({ orderId: objectId, shopSlug:shopSlug.optional() }).strict().parse(req.body);
      const shop=await publicShop(body.shopSlug,{allowDisabled:true});
      const order = await Order.findOne({_id:body.orderId,shopId:shop._id});
      if (!order) throw new HttpError(404, 'Order not found');
      if (!order.razorpayOrderId) throw new HttpError(400, 'Order has no associated gateway ID');
      const paymentId = `pay_demo_${Date.now()}`;
      const payment = { id: paymentId, order_id: order.razorpayOrderId, amount: order.total * 100, currency: 'INR', status: 'captured', method: 'upi' };
      if (gateway.payments?.registerPayment) gateway.payments.registerPayment(payment);
      const paid = await finalizePayment(payment);
      res.json({ orderId: paid._id, orderCode: paid.orderCode, tokenNo: paid.tokenNo, status: paid.status });
    }));
  }
  app.post('/api/payments/verify', paymentPost, asyncRoute(async (req, res) => {
    const body = z.object({ orderId: objectId, shopSlug:shopSlug.optional(), razorpayOrderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().max(128) }).strict().parse(req.body);
    const shop=await publicShop(body.shopSlug,{allowDisabled:true});
      const order = await Order.findOne({_id:body.orderId,shopId:shop._id});
    if (!order || order.razorpayOrderId !== body.razorpayOrderId || !validSignature(`${order.razorpayOrderId}|${body.paymentId}`, body.signature, config.RAZORPAY_KEY_SECRET)) throw new HttpError(400, 'Payment verification failed');
    const payment = await gateway.payments.fetch(body.paymentId);
    if (payment.order_id !== order.razorpayOrderId || payment.id !== body.paymentId) throw new HttpError(400, 'Payment does not belong to this order');
    const paid = await finalizePayment(payment); res.json({ orderId: paid._id, orderCode: paid.orderCode, tokenNo: paid.tokenNo, status: paid.status });
  }));
  // Bound fallback gateway reads when phones repeatedly poll an unpaid order.
  const reconciliationChecks=new Map();
  app.get('/api/orders/:id', limit(300), asyncRoute(async (req, res) => {
    const q=z.object({shopSlug:shopSlug.optional()}).strict().parse(req.query);
    const shop=await publicShop(q.shopSlug,{allowDisabled:true});
    const isObjectId = /^[a-f\d]{24}$/i.test(req.params.id);
    const query = isObjectId ? { _id: req.params.id } : { orderCode: req.params.id.toUpperCase() };
    let order = await Order.findOne({...query,shopId:shop._id}).select('orderCode tokenNo tokenDate status items total createdAt razorpayOrderId').lean();
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.status === 'PENDING_PAYMENT' && order.razorpayOrderId && !gateway.isDemo && gateway?.orders?.fetch && gateway.orders.fetchPayments && Date.now()-(reconciliationChecks.get(order._id)||0)>=10000) {
      reconciliationChecks.delete(order._id);
      reconciliationChecks.set(order._id,Date.now());
      if(reconciliationChecks.size>1000)reconciliationChecks.delete(reconciliationChecks.keys().next().value);
      try {
        const remote = await gateway.orders.fetch(order.razorpayOrderId);
        if (remote.status === 'paid') {
          const payments = await gateway.orders.fetchPayments(order.razorpayOrderId);
          const captured = payments?.items?.find(p => p.status === 'captured');
          if (captured) {
            const paid = await finalizePayment(captured);
            order = { ...order, ...paid, status: paid.status, tokenNo: paid.tokenNo, orderCode: paid.orderCode };
          }
        }
      } catch { /* Continue normal flow if gateway query fails */ }
    }
    const latest = await PrintJob.findOne({ orderId: order._id }).sort({ createdAt: -1, _id: -1 });
    // Reconciliation returns a complete database row. Never spread that row into
    // a public response: it contains phone, customer name and checkout secrets.
    const {_id,orderCode,tokenNo,tokenDate,status,items,total,createdAt}=order;
    res.json({ _id,orderId:_id,orderCode,tokenNo,tokenDate,status,items,total,createdAt,shop:shopView(shop),shopName:shop.name,printed:latest?.status==='PRINTED' });
  }));
  app.use('/api/agent', agentRouter(config)); app.use('/api/admin', adminRouter(config, imageStorage, invalidateMenu));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Endpoint not found')));
  const dist = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  const staticOptions={ setHeaders(res, path) { if (path.includes('assets')) res.set('Cache-Control', 'public,max-age=31536000,immutable'); else res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); } };
  app.use('/freshme',express.static(dist,staticOptions));
  app.use(express.static(dist,staticOptions));
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
