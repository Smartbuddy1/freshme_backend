import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { isProductImageUrl } from './images.js';
import { z } from 'zod';
import { Admin, Order, PrintJob, Product, Settings, paymentSummary } from './models.js';
import { asyncRoute, HttpError, objectId, dateString, istDate, dayRange, csvCell, isAllowedOrigin } from './utils.js';
import { receiptPayload } from './payments.js';
const sizes = z.array(z.object({ label: z.string().trim().min(1).max(30), price: z.number().int().min(1).max(10000) }).strict()).min(1).max(3).refine(s => new Set(s.map(i => i.label)).size === s.length, 'Size names must be unique');
const productInput = z.object({ name: z.string().trim().min(1).max(80), category: z.string().trim().min(1).max(40), flavorColor: z.string().regex(/^#[a-f\d]{6}$/i), imageUrl: z.string().refine(v => v === '' || isProductImageUrl(v), 'Use an uploaded product image').default(''), sizes, available: z.boolean(), sortOrder: z.number().int().min(0).max(10000) }).strict();
const settingsInput = z.object({ shopName: z.string().trim().min(1).max(60), tagline: z.string().trim().max(120), acceptingOrders: z.boolean() }).strict();
const queryInput = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), status: z.enum(['PENDING_PAYMENT','PAID','SERVED','EXPIRED']).optional(), date: dateString.optional(), token: z.coerce.number().int().positive().optional() }).strict();
export async function withPrintStatus(orders) {
  const jobs = await PrintJob.find({ orderId: { $in: orders.map(o => o._id) } }).sort({ createdAt: -1, _id: -1 }).lean();
  return orders.map(o => ({ ...o, printStatus: jobs.find(j => String(j.orderId) === String(o._id))?.status || 'NONE', printError: jobs.find(j => String(j.orderId) === String(o._id))?.lastError || '' }));
}
export function adminRouter(config, imageStorage) {
  const router = Router();
  const cookie = { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/api/admin' };
  router.use((req, res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if ((config.NODE_ENV === 'production' && !origin) || !isAllowedOrigin(origin, config.CLIENT_ORIGIN, config.NODE_ENV === 'production')) return next(new HttpError(403, 'Untrusted request origin'));
    }
    next();
  });
  router.post('/login', rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in one minute.' } }), asyncRoute(async (req, res) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).strict().parse(req.body);
    const admin = await Admin.findOne({ email: body.email.toLowerCase() });
    const match = await bcrypt.compare(body.password, admin?.passwordHash || '$2b$12$C6UzMDM.H6dfI/f/IKcEe.5PmeTP6srEbLW8xoCz.FmNtmUAG1Uf2');
    if (!admin || !match) throw new HttpError(401, 'Email or password is incorrect');
    res.cookie('freshme_admin', jwt.sign({ sub: String(admin._id), v: admin.sessionVersion }, config.JWT_SECRET, { expiresIn: '12h', issuer: 'fresh-me', audience: 'admin' }), { ...cookie, maxAge: 43200000 });
    res.json({ email: admin.email });
  }));
  router.use(asyncRoute(async (req, res, next) => {
    try {
      const token = jwt.verify(req.cookies.freshme_admin, config.JWT_SECRET, { algorithms: ['HS256'], issuer: 'fresh-me', audience: 'admin' });
      req.admin = await Admin.findById(token.sub);
      if (!req.admin || req.admin.sessionVersion !== token.v) throw new Error();
    } catch { throw new HttpError(401, 'Please sign in'); }
    next();
  }));
  router.get('/me', (req, res) => res.json({ email: req.admin.email }));
  router.post('/logout', asyncRoute(async (req, res) => { await Admin.updateOne({ _id: req.admin._id }, { $inc: { sessionVersion: 1 } }); res.clearCookie('freshme_admin', cookie).json({ ok: true }); }));
  router.post('/change-password', asyncRoute(async (req, res) => {
    const body = z.object({ currentPassword: z.string().max(128), newPassword: z.string().min(12).max(128) }).strict().parse(req.body);
    if (!(await bcrypt.compare(body.currentPassword, req.admin.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
    await Admin.updateOne({ _id: req.admin._id }, { $set: { passwordHash: await bcrypt.hash(body.newPassword, 12) }, $inc: { sessionVersion: 1 } });
    res.clearCookie('freshme_admin', cookie).json({ ok: true });
  }));
  router.get('/dashboard', asyncRoute(async (req, res) => {
    const [stats, pendingPrints, failedPrints, settings, orders] = await Promise.all([
      paymentSummary(dayRange(istDate())),
      PrintJob.countDocuments({ status: { $in: ['PENDING','PRINTING'] } }), PrintJob.countDocuments({ status: 'FAILED' }), Settings.findById('shop').lean(), Order.find().sort({ createdAt: -1 }).limit(10).lean()
    ]);
    const printerStatus = !settings.agentLastSeenAt || Date.now() - settings.agentLastSeenAt > 20000 ? 'Agent not running' : settings.agentPrinterStatus;
    res.json({ todayOrders: stats[0]?.count || 0, revenue: stats[0]?.revenue || 0, refundedOrders: stats[0]?.refundedOrders || 0, pendingPrints, failedPrints, printerStatus, orders: await withPrintStatus(orders) });
  }));
  router.get('/products', asyncRoute(async (req, res) => res.json(await Product.find({ deleted: false }).sort({ sortOrder: 1 }))));
  router.post('/products', asyncRoute(async (req, res) => res.status(201).json(await Product.create(productInput.parse(req.body)))));
  router.put('/products/:id', asyncRoute(async (req, res) => { const product = await Product.findOneAndUpdate({ _id: objectId.parse(req.params.id), deleted: false }, { $set: productInput.parse(req.body) }, { new: true }); if (!product) throw new HttpError(404, 'Product not found'); res.json(product); }));
  router.patch('/products/:id/availability', asyncRoute(async (req, res) => { const body = z.object({ available: z.boolean() }).strict().parse(req.body); const product = await Product.findOneAndUpdate({ _id: objectId.parse(req.params.id), deleted: false }, { $set: body }, { new: true }); if (!product) throw new HttpError(404, 'Product not found'); res.json(product); }));
  router.delete('/products/:id', asyncRoute(async (req, res) => { await Product.updateOne({ _id: objectId.parse(req.params.id) }, { $set: { deleted: true, available: false } }); res.json({ ok: true }); }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter(req, file, cb) { cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype)); } });
  router.post('/products/image', upload.single('image'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Upload a JPG, PNG or WebP image under 5 MB');
    res.json({ imageUrl: await imageStorage.upload(req.file.buffer) });
  }));
  router.get('/orders', asyncRoute(async (req, res) => {
    const q = queryInput.parse(req.query); const filter = {};
    if (q.status) filter.status = q.status; if (q.date) filter.createdAt = dayRange(q.date); if (q.token) filter.tokenNo = q.token;
    const [orders, total] = await Promise.all([Order.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * 25).limit(25).lean(), Order.countDocuments(filter)]);
    res.json({ orders: await withPrintStatus(orders), total, page: q.page, pages: Math.ceil(total / 25) });
  }));
  router.patch('/orders/:id/serve', asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id); const order = await Order.findOneAndUpdate({ _id: id, status: 'PAID' }, { $set: { status: 'SERVED', servedAt: new Date() } }, { new: true });
    if (!order && !(await Order.exists({ _id: id, status: 'SERVED' }))) throw new HttpError(409, 'Only paid orders can be served'); res.json({ ok: true });
  }));
  router.post('/orders/:id/reprint', asyncRoute(async (req, res) => {
    const order = await Order.findById(objectId.parse(req.params.id));
    if (!order || !['PAID','SERVED'].includes(order.status)) throw new HttpError(409, 'Only paid orders can be reprinted');
    res.status(201).json(await PrintJob.create({ type: 'REPRINT', orderId: order._id, payload: receiptPayload(order) }));
  }));
  router.post('/test-print', asyncRoute(async (req, res) => res.status(201).json(await PrintJob.create({ type: 'TEST', payload: { createdAt: new Date(), items: [] } }))));
  async function payments(req) {
    const q = z.object({ from: dateString.default(istDate()), to: dateString.default(istDate()), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().parse(req.query);
    if (q.from > q.to || new Date(q.to) - new Date(q.from) > 366 * 86400000) throw new HttpError(400, 'Select a date range of up to one year');
    return { q, filter: { paidAt: { $gte: dayRange(q.from).$gte, $lt: dayRange(q.to).$lt } } };
  }
  router.get('/payments', asyncRoute(async (req, res) => {
    const { q, filter } = await payments(req);
    const [orders, totals] = await Promise.all([Order.find(filter).sort({ paidAt: -1 }).skip((q.page - 1) * 50).limit(50).lean(), paymentSummary(filter.paidAt)]);
    res.json({ orders, totals: totals[0] || { total: 0, count: 0, refundedOrders: 0 }, page: q.page, pages: Math.ceil((totals[0]?.count || 0) / 50) });
  }));
  router.get('/payments.csv', asyncRoute(async (req, res) => {
    const { filter } = await payments(req); res.type('text/csv').attachment('fresh-me-payments.csv');
    res.write(['Date (IST)','Token','Amount (INR)','Status','Refunded','Razorpay order','Payment ID','Method'].map(csvCell).join(',') + '\r\n');
    for await (const o of Order.find(filter).sort({ paidAt: -1 }).cursor()) {
      if (res.destroyed) break;
      const line = [new Date(o.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), o.tokenNo, o.total, o.status, o.refunded, o.razorpayOrderId, o.razorpayPaymentId, o.paymentMethod].map(csvCell).join(',') + '\r\n';
      if (!res.write(line)) await new Promise(resolve => { const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); }; res.once('drain', ready); res.once('close', ready); });
    }
    res.end();
  }));
  router.get('/settings', asyncRoute(async (req, res) => res.json(await Settings.findById('shop'))));
  router.put('/settings', asyncRoute(async (req, res) => res.json(await Settings.findByIdAndUpdate('shop', { $set: settingsInput.parse(req.body) }, { new: true }))));
  return router;
}
