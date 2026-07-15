import { CheckCircle2, RefreshCw, AlertTriangle, AlertCircle } from 'lucide-react';
import { syncAtom } from '@/state/sync.atom';
import type { SyncPhase } from '@/lib/ipc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const PHASE: Record<SyncPhase, { icon: typeof CheckCircle2; label: string; className: string }> = {
  idle: { icon: CheckCircle2, label: '已是最新', className: 'text-muted-foreground' },
  syncing: { icon: RefreshCw, label: '同步中…', className: 'text-foreground' },
  error: { icon: AlertCircle, label: '同步出错', className: 'text-destructive' },
  attention: { icon: AlertTriangle, label: '需要处理', className: 'text-destructive' },
};

export function Sync() {
  const status = syncAtom.useData();
  const meta = PHASE[status.phase];
  const Icon = meta.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>同步状态</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className={`flex items-center gap-2 ${meta.className}`}>
          <Icon className={status.phase === 'syncing' ? 'animate-spin' : ''} size={18} />
          <span className="text-sm font-medium">{meta.label}</span>
        </div>
        {status.message && (
          <p className="text-sm text-muted-foreground break-all">{status.message}</p>
        )}
      </CardContent>
    </Card>
  );
}
