import { FolderOpen, LogOut, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { settingsAtom } from '@/state/settings.atom';
import { authAtom } from '@/state/auth.atom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

export function Settings() {
  const [settings, actions] = settingsAtom.use();
  const authActions = authAtom.useChange();
  const navigate = useNavigate();

  async function handleLogout() {
    await authActions.logout();
    navigate('/login', { replace: true });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>设置</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label>本地同步目录</Label>
          <div className="flex items-center gap-2">
            <div className="flex-1 truncate rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {settings.syncDir ?? '未选择'}
            </div>
            <Button
              variant="outline"
              disabled={settings.saving}
              onClick={() => actions.choose()}
            >
              {settings.saving ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              选择目录
            </Button>
          </div>
          {settings.error && (
            <p className="text-sm text-destructive" role="alert">
              {settings.error}
            </p>
          )}
        </div>

        <div className="border-t pt-4">
          <Button variant="destructive" onClick={handleLogout}>
            <LogOut />
            登出并解绑本设备
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
