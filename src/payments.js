import crypto from 'node:crypto';
import { database, transaction } from './database.js';
import { z } from 'zod';
import { Product, Order, Settings, PrintJob, Refund } from './models.js';
import { HttpError, istDate, objectId } from './utils.js';
import { resolveMachine, machineCode, machineSettings } from './machines.js';
export const orderInput = z.object({ machineCode: machineCode.default('DEFAULT'), idempotencyKey: z.string().uuid(), items: z.array(z.object({ productId: objectId, size: z.string().trim().min(1).max(30), qty: z.number().int().min(1).max(20) }).strict()).min(1).max(30), phone: z.string().optional().default(''), customerName: z.string().trim().max(80).optional().default('') }).strict();
export async function calculateOrder(input, machineId = 'default') {
  const products = await Product.find({ _id: { $in: input.items.map(i => i.productId) }, machineId, deleted: false });
  const items = input.items.map(i => {
    const p = products.find(p => String(p._id) === i.productId);
    const size = p?.sizes.find(s => s.label === i.size);
    if (!p?.available || !size) throw new HttpError(409, 'A selected drink or size is unavailable. Please refresh the menu.');
    return { productId: p._id, name: p.name, size: size.label, qty: i.qty, unitPrice: size.price };
  });
  const total = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  if (!Number.isSafeInteger(total) || total <= 0 || total > 100000) throw new HttpError(400, 'Order total is outside the allowed range');
  return { items, total };
}
export async function createOrder(input, gateway, config) {
  const machine = await resolveMachine(input.machineCode || 'DEFAULT');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ items: input.items, phone: input.phone, customerName: input.customerName })).digest('hex');
  let order = await Order.findOne({ idempotencyKey: input.idempotencyKey });
  if (order && order.machineId !== machine._id) throw new HttpError(409, 'This checkout key belongs to a different machine');
  if (!order) {
    const settings = await machineSettings(machine._id);
    if (!settings?.acceptingOrders) throw new HttpError(409, 'Machine is resting, back soon');
    const calculated = await calculateOrder(input, machine._id);
    try { order = await Order.create({ ...input, ...calculated, machineId: machine._id, requestHash }); }
    catch (e) { if (e.code !== '23505') throw e; order = await Order.findOne({ idempotencyKey: input.idempotencyKey }); }
  }
  if (order.machineId !== machine._id || order.requestHash !== requestHash) throw new HttpError(409, 'This checkout key belongs to a different cart');
  if (order.status === 'EXPIRED' || (order.status === 'PENDING_PAYMENT' && Date.now() - order.createdAt > 30 * 60000)) throw new HttpError(410, 'Checkout expired. Please try again.');
  if (order.status === 'PENDING_PAYMENT' && order.razorpayOrderId && !gateway?.isDemo && gateway?.orders?.fetch) {
    try {
      const remote = await gateway.orders.fetch(order.razorpayOrderId);
      if (remote.status === 'paid') {
        const payments = await gateway.orders.fetchPayments(order.razorpayOrderId);
        const captured = payments?.items?.find(p => p.status === 'captured');
        if (captured) order = await finalizePayment(captured);
      }
    } catch { /* Continue normal flow if gateway query fails */ }
  }
  if (!order.razorpayOrderId) {
    // Persist ownership before the external call. Never blindly repeat an ambiguous create.
    const owned = await Order.findOneAndUpdate({ _id: order._id, razorpayCreateStartedAt: { $exists: false } }, { $set: { razorpayCreateStartedAt: new Date() } }, { new: true });
    if (owned) {
      try {
        const remote = await gateway.orders.create({ amount: order.total * 100, currency: 'INR', receipt: String(order._id) });
        order = await Order.findByIdAndUpdate(order._id, { $set: { razorpayOrderId: remote.id } }, { new: true });
      } catch {
        await Order.updateOne({ _id: order._id }, { $set: { creationError: 'Gateway response uncertain; reconciliation required' } });
        throw new HttpError(503, 'Payment service is taking longer than usual. Retry this checkout shortly.');
      }
    } else {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        order = await Order.findById(order._id);
        if (order.razorpayOrderId) break;
      }
      if (!order.razorpayOrderId && Date.now() - order.razorpayCreateStartedAt > 30000) {
        const matches = await gateway.orders.all({ receipt: String(order._id), count: 100 });
        const remote = matches.items?.find(r => r.receipt === String(order._id) && r.amount === order.total * 100 && r.currency === 'INR');
        if (remote) order = await Order.findByIdAndUpdate(order._id, { $set: { razorpayOrderId: remote.id } }, { new: true });
      }
      if (!order.razorpayOrderId) throw new HttpError(503, 'Checkout is being prepared. Please retry shortly.');
    }
  }
  return { orderId: String(order._id), orderCode: order.orderCode, razorpayOrderId: order.razorpayOrderId, amount: order.total * 100, keyId: config.RAZORPAY_KEY_ID, status: order.status, isDemo: Boolean(gateway?.isDemo) };
}
export function receiptPayload(order) { return { tokenNo: order.tokenNo, orderCode: order.orderCode || (order.tokenNo ? `ORD-${100 + order.tokenNo}` : undefined), createdAt: order.paidAt, customerName: order.customerName, total: order.total, paymentId: order.razorpayPaymentId, items: order.items }; }
export async function finalizePayment(payment) {
  if (payment.status !== 'captured') throw new HttpError(409, 'Payment is awaiting capture. Your token will appear automatically once confirmed.');
  const result = await transaction(async client => {
    const { rows: [order] } = await client.query('SELECT * FROM fresh_me.orders WHERE "razorpayOrderId"=$1 FOR UPDATE', [payment.order_id]);
    if (!order) throw new HttpError(404, 'Payment order not found');
    if (payment.amount !== order.total * 100 || payment.currency !== 'INR') throw new HttpError(400, 'Payment amount or currency does not match');
    if (['PAID','SERVED'].includes(order.status)) {
      if (order.razorpayPaymentId !== payment.id) throw new HttpError(409, 'Order has a different payment');
      return order;
    }
    const now = new Date(); const tokenDate = istDate(now);
    const nextCounter = async id => (await client.query('INSERT INTO fresh_me.counters (_id, seq) VALUES ($1,1) ON CONFLICT (_id) DO UPDATE SET seq=fresh_me.counters.seq+1 RETURNING seq', [id])).rows[0].seq;
    const tokenNo = await nextCounter(order.machineId === 'default' ? tokenDate : `${order.machineId}:${tokenDate}`);
    const orderCode = 'ORD-' + (100 + await nextCounter('order_seq'));
    const { rows: [paid] } = await client.query(
      'UPDATE fresh_me.orders SET status=\'PAID\', "paidAt"=$2, "tokenDate"=$3, "tokenNo"=$4, "orderCode"=$5, "razorpayPaymentId"=$6, "paymentMethod"=$7, refunded=EXISTS(SELECT 1 FROM fresh_me.refunds WHERE "paymentId"=$6), "updatedAt"=now() WHERE _id=$1 RETURNING *',
      [order._id, now, tokenDate, tokenNo, orderCode, payment.id, payment.method || 'unknown']);
    await PrintJob.create({ machineId: paid.machineId, type: 'ORDER', orderId: paid._id, payload: receiptPayload(paid) }, client);
    return paid;
  });
  // Close the refund-before-payment race in both possible commit orders.
  if (await Refund.exists({ paymentId: payment.id })) await Order.updateOne({ _id: result._id }, { $set: { refunded: true } });
  return result;
}
export async function recordRefund(refund) {
  await database().query('INSERT INTO fresh_me.refunds (_id, "paymentId") VALUES ($1,$2) ON CONFLICT (_id) DO UPDATE SET "paymentId"=EXCLUDED."paymentId", "updatedAt"=now()', [refund.id, refund.payment_id]);
  await Order.updateOne({ razorpayPaymentId: refund.payment_id }, { $set: { refunded: true } });
}
export async function expireOrders() { await Order.updateMany({ status: 'PENDING_PAYMENT', createdAt: { $lt: new Date(Date.now() - 1800000) } }, { $set: { status: 'EXPIRED' } }); }
