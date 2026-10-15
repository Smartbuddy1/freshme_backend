import crypto from 'node:crypto';
import { z } from 'zod';
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s, 'Invalid date');
export function istDate(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
export function dayRange(date) { const start = new Date(`${date}T00:00:00+05:30`); return { $gte: start, $lt: new Date(+start + 86400000) }; }
export function safeEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const x = crypto.createHash('sha256').update(a).digest(); const y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); }
export function validSignature(body, signature, secret) { return typeof signature === 'string' && /^[a-f\d]{64}$/i.test(signature) && safeEqual(crypto.createHmac('sha256', secret).update(body).digest('hex'), signature.toLowerCase()); }
export function csvCell(value) { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; }
export function publicSettings(s) { return { shopName: s.shopName, tagline: s.tagline, acceptingOrders: s.acceptingOrders }; }
export function isAllowedOrigin(origin, clientOrigin, isProduction = false) {
  if (!origin) return true;
  if (origin === clientOrigin) return true;
  if (clientOrigin) {
    const withWww = clientOrigin.replace('://', '://www.');
    const withoutWww = clientOrigin.replace('://www.', '://');
    if (origin === withWww || origin === withoutWww) return true;
  }
  if (isProduction) return false;
  if (origin.endsWith('.trycloudflare.com') || origin.endsWith('.loca.lt')) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
}
