import { useState, type MouseEvent, type ReactElement } from 'react';
import { FolderInput, FolderOpen, Loader2, LogOut, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router';
import { settingsAtom } from '@/state/settings.atom';
import { authAtom } from '@/state/auth.atom';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

type PendingDirectoryOperation =
  | { kind: 'empty'; path: string }
  | { kind: 'move'; path: string };

interface DialogCopy {
  title: string;
  action: string;
}

function dialogCopy(isMove: boolean, hasSyncDirectory: boolean): DialogCopy {
  if (isMove) return { title: '移动同步目录？', action: '移动同步目录' };
  if (hasSyncDirectory) return { title: '改用新的空目录？', action: '改用此空目录' };
  return { title: '设置同步目录？', action: '设为同步目录' };
}

/** 同步目录设置：只允许改用严格空目录，或同卷原子移动整个目录。 */
export function Settings(): ReactElement {
  const [settings, actions] = settingsAtom.use();
  const authActions = authAtom.useChange();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingDirectoryOperation | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function handleLogout(): Promise<void> {
    await authActions.logout();
    navigate('/login', { replace: true });
  }

  async function chooseEmptyDirectory(): Promise<void> {
    const path = await actions.pickEmptyDirectory();
    if (path) openConfirmation({ kind: 'empty', path });
  }

  async function chooseMoveDestination(): Promise<void> {
    const path = await actions.pickMoveDestination();
    if (path) openConfirmation({ kind: 'move', path });
  }

  function openConfirmation(operation: PendingDirectoryOperation): void {
    setAcknowledged(false);
    setPending(operation);
  }

  function closeConfirmation(): void {
    if (settings.saving) return;
    setAcknowledged(false);
    setPending(null);
  }

  async function confirmDirectoryOperation(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault();
    if (!pending || !acknowledged) return;

    const saved =
      pending.kind === 'empty'
        ? await actions.configureEmptyDirectory(pending.path)
        : await actions.relocateDirectory(pending.path);
    if (saved) closeConfirmation();
  }

  const hasSyncDirectory = settings.syncDir !== null;
  const isMove = pending?.kind === 'move';
  const copy = dialogCopy(isMove, hasSyncDirectory);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>设置</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>本地同步目录</Label>
            <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground break-all">
              {settings.syncDir ?? '未选择'}
            </div>
            {hasSyncDirectory ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={settings.saving} onClick={() => void chooseEmptyDirectory()}>
                  {settings.saving ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                  改用空目录
                </Button>
                <Button variant="outline" disabled={settings.saving} onClick={() => void chooseMoveDestination()}>
                  <FolderInput />
                  移动到新位置
                </Button>
              </div>
            ) : (
              <Button className="self-start" variant="outline" disabled={settings.saving} onClick={() => void chooseEmptyDirectory()}>
                {settings.saving ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                选择空目录
              </Button>
            )}
            <p className="text-sm text-muted-foreground">
              同步目录已配置后，只能改用空目录或将整个目录移动到同一磁盘的新位置。
            </p>
            {settings.error && (
              <p className="text-sm text-destructive" role="alert">
                {settings.error}
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <Button variant="destructive" onClick={() => void handleLogout()}>
              <LogOut />
              登出并解绑本设备
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && closeConfirmation()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="text-destructive" />
              {copy.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isMove
                ? '同步会暂停，目录会被原子移动到所选位置下。路径变化后将重新建立同步基线。'
                : '新目录必须完全为空。应用会从云端重新下载同步盘，而不会移动旧目录中的文件。'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="font-medium">{isMove ? '目标上级目录' : '新同步目录'}</p>
            <p className="mt-1 break-all text-muted-foreground">{pending?.path}</p>
          </div>

          {isMove ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>移动期间不要修改同步目录中的文件。</li>
              <li>只支持同一磁盘；跨磁盘目标会被拒绝，不会复制或删除文件。</li>
              <li>若操作中断，请不要手动删除任一目录，重新打开来福处理。</li>
            </ul>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>旧同步目录会停止同步，但不会被移动或删除。</li>
              <li>继续修改旧目录的文件，不会再自动上传。</li>
              <li>确认新目录完整同步前，请保留旧目录。</li>
            </ul>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={settings.saving}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>我理解以上后果，并确认继续。</span>
          </label>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={settings.saving}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!acknowledged || settings.saving} onClick={(event) => void confirmDirectoryOperation(event)}>
              {settings.saving && <Loader2 className="animate-spin" />}
              {copy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
