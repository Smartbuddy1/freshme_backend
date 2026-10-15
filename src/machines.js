import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Machine, Settings } from './models.js';
import { HttpError } from './utils.js';
export const machineCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/);
export const keyHash = value => createHash('sha256').update(value).digest('hex');
export const settingsId = id => id === 'default' ? 'shop' : id;
export async function resolveMachine(code = 'DEFAULT', { enabled = true } = {}) {
  const machine = await Machine.findOne({ code: machineCode.parse(code) });
  if (!machine || (enabled && !machine.enabled)) throw new HttpError(404, 'Machine not found');
  return machine;
}
export const publicMachine = m => ({ id: m._id, code: m.code, name: m.name, enabled: m.enabled, isQa: m.isQa });
export async function machineSettings(id) { return Settings.findById(settingsId(id)); }
export function ownerOnly(req, res, next) { return req.admin.role === 'OWNER' ? next() : next(new HttpError(403, 'Owner access required')); }
export function canAccess(admin, id) { return admin.role === 'OWNER' || admin.machineIds.includes(id); }
export async function adminMachine(req) {
  const selected = req.get('x-machine-code');
  const fallback = req.admin.role === 'MANAGER' ? await Machine.findById(req.admin.machineIds[0] || '') : null;
  const machine = await resolveMachine(selected || fallback?.code || 'DEFAULT', { enabled: false });
  if (!canAccess(req.admin, machine._id)) throw new HttpError(403, 'Machine access denied');
  return machine;
}
