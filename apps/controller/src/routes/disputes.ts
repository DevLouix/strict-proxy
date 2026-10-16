/**
 * Admin dispute (chargeback) workflow.
 *
 * A dispute now revokes access automatically — see `charge.disputed` in the
 * payment pipeline. That is the correct default, but it is only half the job:
 * without a way to see the dispute and file evidence, the merchant simply loses
 * the money and the customer. These routes close that loop.
 *
 * Everything is proxied from the provider and never persisted locally, so the
 * controller cannot drift out of sync with the chargeback record of truth.
 */
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import type { Redis } from 'ioredis';
import { asyncHandler, requireJwt } from '../middleware.js';
import { createOpenPayClient, describeOpenPayError, isOpenPayConfigured } from '../services/openpay.js';

interface Ctx {
  db: Db;
  cfg: ControllerConfig;
  redis: Redis;
}

export function buildDisputesRouter(ctx: Ctx): Router {
  const router = Router();

  /** Every admin route below needs both a JWT and the admin role. */
  const admin = [requireJwt(ctx.cfg, ctx.db)];

  router.get(
    '/api/v1/admin/disputes',
    ...admin,
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const status = typeof req.query.status === 'string' && req.query.status.length > 0 ? req.query.status : undefined;

      try {
        const client = createOpenPayClient(ctx.cfg);
        const result = await client.disputes.list(status ? { status } : undefined);
        res.json({ disputes: result?.data ?? [], hasMore: Boolean(result?.has_more) });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  router.get(
    '/api/v1/admin/disputes/:disputeId',
    ...admin,
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const disputeId = typeof req.params.disputeId === 'string' ? req.params.disputeId.trim() : '';
      if (!disputeId) {
        res.status(400).json({ error: 'disputeId is required', code: 'VALIDATION' });
        return;
      }

      try {
        const client = createOpenPayClient(ctx.cfg);
        const dispute = await client.disputes.get(disputeId);
        res.json({ dispute });
      } catch (err) {
        const described = describeOpenPayError(err);
        // A dispute the provider cannot find is a 404 to our caller too.
        const status = described.status === 502 && /not found/i.test(described.message) ? 404 : described.status;
        res.status(status).json({ error: described.message, code: described.code });
      }
    }),
  );

  router.get(
    '/api/v1/admin/disputes/:disputeId/evidence',
    ...admin,
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const disputeId = typeof req.params.disputeId === 'string' ? req.params.disputeId.trim() : '';
      if (!disputeId) {
        res.status(400).json({ error: 'disputeId is required', code: 'VALIDATION' });
        return;
      }

      try {
        const client = createOpenPayClient(ctx.cfg);
        const result = await client.disputes.listEvidenceSubmissions(disputeId);
        res.json({ submissions: result?.data ?? [] });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code });
      }
    }),
  );

  router.post(
    '/api/v1/admin/disputes/:disputeId/evidence',
    ...admin,
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const disputeId = typeof req.params.disputeId === 'string' ? req.params.disputeId.trim() : '';
      const body = req.body as {
        narrative?: string;
        evidence?: Record<string, unknown>;
        file_urls?: string[];
        auto_generate?: boolean;
        template_version?: string;
      };

      // A narrative is what the card scheme actually reads; refuse an empty one
      // rather than filing a packet that will be rejected.
      if (!disputeId) {
        res.status(400).json({ error: 'disputeId is required', code: 'VALIDATION' });
        return;
      }
      if (!body.narrative || body.narrative.trim().length < 20) {
        res.status(400).json({ error: 'a narrative of at least 20 characters is required', code: 'VALIDATION' });
        return;
      }

      try {
        const client = createOpenPayClient(ctx.cfg);
        const submission = await client.disputes.submitEvidence(disputeId, {
          narrative: body.narrative.trim(),
          evidence: body.evidence,
          file_urls: body.file_urls,
          auto_generate: body.auto_generate,
          template_version: body.template_version,
        });
        res.status(201).json({ submission });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code, providerCode: described.providerCode });
      }
    }),
  );

  router.post(
    '/api/v1/admin/disputes/:disputeId/evidence/:submissionId/submitted',
    ...admin,
    asyncHandler(async (req: Request, res: Response) => {
      if (req.auth?.role !== 'admin') {
        res.status(403).json({ error: 'administrator access required', code: 'FORBIDDEN' });
        return;
      }
      if (!isOpenPayConfigured(ctx.cfg)) {
        res.status(503).json({ error: 'billing gateway is not configured', code: 'BILLING_NOT_CONFIGURED' });
        return;
      }

      const disputeId = typeof req.params.disputeId === 'string' ? req.params.disputeId.trim() : '';
      const submissionId = typeof req.params.submissionId === 'string' ? req.params.submissionId.trim() : '';
      if (!disputeId || !submissionId) {
        res.status(400).json({ error: 'disputeId and submissionId are required', code: 'VALIDATION' });
        return;
      }

      try {
        const client = createOpenPayClient(ctx.cfg);
        // Most providers still have no public evidence API, so this records that
        // the packet was filed by hand in their dashboard.
        const submission = await client.disputes.markSubmitted(disputeId, submissionId);
        res.json({ submission });
      } catch (err) {
        const described = describeOpenPayError(err);
        res.status(described.status).json({ error: described.message, code: described.code });
      }
    }),
  );

  return router;
}