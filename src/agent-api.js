import { database } from './database.js';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrintJob, Settings } from './models.js';
import { asyncRoute, HttpError, safeEqual, objectId } from './utils.js';
export async function claimJobs(limit = 5) {
  const jobs = [];
  for (let i = 0; i < limit; i++) {
    const { rows: [job] } = await database().query(
      `WITH candidate AS (
        SELECT _id FROM fresh_me.print_jobs WHERE status='PENDING' OR (status='PRINTING' AND "claimedAt"<$1)
        ORDER BY "createdAt", _id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE fresh_me.print_jobs SET status='PRINTING', "claimedAt"=now(), "claimId"=$2, "updatedAt"=now()
      WHERE _id IN (SELECT _id FROM candidate) RETURNING *`,
      [new Date(Date.now() - 60000), randomUUID()]);
    if (!job) break;
    jobs.push({ _id: job._id, type: job.type, orderId: job.orderId, claimId: job.claimId, ...job.payload });
  }
  return jobs;
}
export function agentRouter(config) {
  const router = Router();
  router.use((req, res, next) => safeEqual(req.get('x-agent-key'), config.AGENT_KEY) ? next() : next(new HttpError(401, 'Agent key rejected')));
  router.post('/heartbeat', asyncRoute(async (req, res) => {
    const { printer } = z.object({ printer: z.enum(['online','offline','unknown']) }).strict().parse(req.body);
    await Settings.updateOne({ _id: 'shop' }, { $set: { agentLastSeenAt: new Date(), agentPrinterStatus: printer } });
    res.json({ ok: true });
  }));
  router.get('/jobs', asyncRoute(async (req, res) => {
    const printer = z.enum(['online','offline','unknown']).default('unknown').parse(req.query.printer);
    await Settings.updateOne({ _id: 'shop' }, { $set: { agentLastSeenAt: new Date(), agentPrinterStatus: printer } });
    res.json(await claimJobs());
  }));
  router.post('/jobs/:id/renew', asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id); const { claimId } = z.object({ claimId: z.string().uuid() }).strict().parse(req.body);
    const result = await PrintJob.updateOne({ _id: id, status: 'PRINTING', claimId }, { $set: { claimedAt: new Date() } });
    if (!result.matchedCount) throw new HttpError(409, 'Print claim has expired');
    res.json({ ok: true });
  }));
  router.post('/jobs/:id/done', asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id); const { claimId } = z.object({ claimId: z.string().uuid() }).strict().parse(req.body);
    const job = await PrintJob.findOneAndUpdate({ _id: id, status: 'PRINTING', claimId }, { $set: { status: 'PRINTED', printedAt: new Date(), lastError: '' } }, { new: true });
    if (!job && !(await PrintJob.exists({ _id: id, status: 'PRINTED' }))) throw new HttpError(409, 'Print claim has expired');
    res.json({ ok: true });
  }));
  router.post('/jobs/:id/failed', asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id); const body = z.object({ error: z.string().max(500), claimId: z.string().uuid() }).strict().parse(req.body);
    const { rows: [job] } = await database().query(
      `UPDATE fresh_me.print_jobs SET attempts=attempts+1, "lastError"=$3,
        status=CASE WHEN attempts+1>=5 THEN 'FAILED' ELSE 'PENDING' END, "updatedAt"=now()
        WHERE _id=$1 AND status='PRINTING' AND "claimId"=$2 RETURNING *`, [id, body.claimId, body.error]);
    if (!job) {
      const previous = await PrintJob.findOne({ _id: id, claimId: body.claimId, status: { $in: ['PENDING','FAILED'] } });
      if (!previous) throw new HttpError(409, 'Print claim has expired');
    }
    res.json({ ok: true });
  }));
  return router;
}
