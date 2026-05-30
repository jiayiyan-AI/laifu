import { Router, type Request, type Response, type Router as RouterType, type RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PurchaseResponse } from '@lingxi/shared';
import type { ContainerMappingCache } from '../db/cache.js';

export type ProvisionerFn = (args: { userId: string; containerName: string; shareName: string }) => Promise<void>;

const shortHash = (userId: string): string => userId.replace(/-/g, '').slice(0, 8);

export const buildPurchaseRouter = (
  sb: SupabaseClient,
  cache: ContainerMappingCache,
  provisioner: ProvisionerFn,
  sessionMw: RequestHandler,
): RouterType => {
  const router = Router();

  router.post('/api/purchase', sessionMw, async (req: Request, res: Response) => {
    const userId = req.session!.user_id;
    const hash = shortHash(userId);
    const containerName = `hermes-${hash}`;
    const shareName = `user-${hash}`;

    const { error: insErr } = await sb
      .from('container_mapping')
      .insert({
        user_id: userId,
        container_name: containerName,
        azure_files_share: shareName,
        status: 'provisioning',
        progress_pct: 0,
      });

    if (insErr) {
      const existing = cache.get(userId);
      if (existing) {
        const body: PurchaseResponse = { user_id: userId, status: existing.status };
        return res.json(body);
      }
      return res.status(500).json({ error: (insErr as Error).message ?? 'insert failed' });
    }

    const { data } = await sb.from('container_mapping').select('*').eq('user_id', userId).single();
    if (data) cache.set(data as any);

    provisioner({ userId, containerName, shareName }).catch((err) => {
      console.error(`[purchase] provisioner error for ${userId}:`, err);
    });

    const body: PurchaseResponse = { user_id: userId, status: 'provisioning' };
    res.json(body);
  });

  return router;
};
