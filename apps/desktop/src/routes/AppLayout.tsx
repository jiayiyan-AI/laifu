import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { RefreshCcw, Settings as SettingsIcon, Loader2 } from 'lucide-react';
import { authAtom } from '@/state/auth.atom';
import { cn } from '@/lib/utils';

/** 已登录布局：顶部标题 + tab 导航 + Outlet；未登录守卫跳 /login。 */
export function AppLayout() {
  const auth = authAtom.useData();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.phase === 'unauthed') navigate('/login', { replace: true });
  }, [auth.phase, navigate]);

  if (auth.phase !== 'authed') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="mr-2 animate-spin" size={18} />
        加载中…
      </div>
    );
  }

  const tab = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      isActive ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent',
    );

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <h1 className="text-base font-semibold">来福同步盘</h1>
        <nav className="flex items-center gap-1">
          <NavLink to="/sync" className={tab}>
            <RefreshCcw size={16} />
            同步
          </NavLink>
          <NavLink to="/settings" className={tab}>
            <SettingsIcon size={16} />
            设置
          </NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-2xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
