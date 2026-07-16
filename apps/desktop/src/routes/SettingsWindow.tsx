import type { ReactElement } from 'react';
import { Loader2, LogIn, PanelTop } from 'lucide-react';
import { authAtom } from '@/state/auth.atom';
import { showSyncFlyoutFromSettings } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Settings } from '@/routes/Settings';

export function SettingsWindow(): ReactElement {
  const [auth, actions] = authAtom.use();

  if (auth.phase === 'unknown') {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 animate-spin" size={16} />
        正在读取设备状态…
      </main>
    );
  }

  if (auth.phase === 'unauthed') {
    return (
      <main className="min-h-screen bg-background p-6">
        <Card className="mx-auto max-w-md">
          <CardHeader>
            <CardTitle>来福设置</CardTitle>
            <CardDescription>登录后可管理同步盘与本设备绑定。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button disabled={auth.loggingIn} onClick={() => void actions.login()}>
              {auth.loggingIn ? <Loader2 className="animate-spin" /> : <LogIn />}
              {auth.loggingIn ? '登录中…' : '登录'}
            </Button>
            {auth.error && <p className="text-sm text-destructive" role="alert">登录失败：{auth.error}</p>}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background p-6">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">来福设置</h1>
        <Button variant="outline" size="sm" onClick={() => void showSyncFlyoutFromSettings()}>
          <PanelTop />
          打开状态面板
        </Button>
      </header>
      <Settings />
    </main>
  );
}
