import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PurchaseResponse } from '@lingxi/shared';
import type { ContainerMappingCache } from '../db/cache.js';

export type ProvisionerFn = (args: { userId: string; containerName: string; shareName: string }) => Promise<void>;

const shortHash = (userId: string): string => userId.replace(/-/g, '').slice(0, 8);

export const buildPurchaseRouter = (
  sb: SupabaseClient,
  cache: ContainerMappingCache,
  provisioner: ProvisionerFn,
): ReturnType<typeof Router> => {
  const router = Router();

  router.post('/api/purchase', async (req: Request, res: Response) => {
    const userId = req.header('x-user-id');
    if (!userId) return res.status(400).json({ error: 'x-user-id required' });

    const hash = shortHash(userId);
    const containerName = `hermes-${hash}`;
    const shareName = `user-${hash}`;

    // 幂等：用 ON CONFLICT 防止重复 INSERT
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
      // 已经存在 → 直接返回当前状态
      const existing = cache.get(userId);
      if (existing) {
        const body: PurchaseResponse = { user_id: userId, status: existing.status };
        return res.json(body);
      }
      // 真正的写入错误
      return res.status(500).json({ error: (insErr as Error).message ?? 'insert failed' });
    }

    // 同步更新 cache（先放一个 provisioning 占位）
    const { data } = await sb.from('container_mapping').select('*').eq('user_id', userId).single();
    if (data) cache.set(data as any);

    // 异步触发 provisioning（fire-and-forget）
    provisioner({ userId, containerName, shareName }).catch((err) => {
      console.error(`[purchase] provisioner error for ${userId}:`, err);
    });

    const body: PurchaseResponse = { user_id: userId, status: 'provisioning' };
    res.json(body);
  });

  return router;
};
