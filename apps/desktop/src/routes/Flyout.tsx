import { useEffect, type ReactElement, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LogIn,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { authAtom } from '@/state/auth.atom';
import { settingsAtom } from '@/state/settings.atom';
import { syncAtom } from '@/state/sync.atom';
import type { SyncPhase } from '@/lib/ipc';
import { showSettingsWindow } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PHASE: Record<SyncPhase, { icon: typeof CheckCircle2; label: string; className: string }> = {
  idle: { icon: CheckCircle2, label: '已是最新', className: 'text-muted-foreground' },
  syncing: { icon: RefreshCw, label: '同步中…', className: 'text-foreground' },
  error: { icon: AlertCircle, label: '同步出错', className: 'text-destructive' },
  attention: { icon: AlertTriangle, label: '需要处理', className: 'text-destructive' },
};

export function Flyout(): ReactElement {
  const [auth, authActions] = authAtom.use();
  const status = syncAtom.useData();
  const settings = settingsAtom.useData();
  useEffect(() => {
    document.documentElement.classList.add('flyout-surface');
    return () => document.documentElement.classList.remove('flyout-surface');
  }, []);
  const meta = PHASE[status.phase];
  const Icon = meta.icon;

  if (auth.phase === 'unknown') {
    return <LoadingFlyout />;
  }

  if (auth.phase === 'unauthed') {
    return (
      <FlyoutFrame>
        <CardHeader>
          <CardTitle>来福状态</CardTitle>
          <CardDescription>登录后即可将本设备绑定到你的来福账号。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button onClick={() => void authActions.login()} disabled={auth.loggingIn}>
            {auth.loggingIn ? <Loader2 className="animate-spin" /> : <LogIn />}
            {auth.loggingIn ? '登录中…' : '登录'}
          </Button>
          {auth.error && <p className="text-sm text-destructive" role="alert">登录失败：{auth.error}</p>}
        </CardContent>
      </FlyoutFrame>
    );
  }

  return (
    <FlyoutFrame>
      <CardHeader>
        <CardTitle>来福状态</CardTitle>
        <CardDescription className={`flex items-center gap-2 ${meta.className}`}>
          <Icon className={status.phase === 'syncing' ? 'animate-spin' : ''} size={16} />
          {meta.label}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">同步目录</p>
          <p className="mt-1 break-all text-sm">{settings.syncDir ?? '尚未配置同步目录'}</p>
        </div>
        {status.message && <p className="text-sm text-destructive" role="alert">{status.message}</p>}
        <Button onClick={() => void showSettingsWindow()}>
          <Settings />
          打开设置…
        </Button>
      </CardContent>
    </FlyoutFrame>
  );
}

function FlyoutFrame({ children }: { children: ReactNode }): ReactElement {
  return <Card className="m-3 border-0 shadow-none">{children}</Card>;
}

function LoadingFlyout(): ReactElement {
  return (
    <FlyoutFrame>
      <CardContent className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" size={16} />
        正在读取状态…
      </CardContent>
    </FlyoutFrame>
  );
}
