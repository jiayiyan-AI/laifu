import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { LogIn, Loader2 } from 'lucide-react';
import { authAtom } from '@/state/auth.atom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Login() {
  const [auth, actions] = authAtom.use();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.phase === 'authed') navigate('/flyout', { replace: true });
  }, [auth.phase, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-xl">来福同步盘</CardTitle>
          <CardDescription>登录以将本设备绑定到你的账号</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button className="w-full" disabled={auth.loggingIn} onClick={() => actions.login()}>
            {auth.loggingIn ? (
              <>
                <Loader2 className="animate-spin" />
                登录中…
              </>
            ) : (
              <>
                <LogIn />
                登录
              </>
            )}
          </Button>
          {auth.error && (
            <p className="text-sm text-destructive" role="alert">
              登录失败：{auth.error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
