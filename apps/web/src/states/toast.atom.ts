import { atom } from '@lingxi/atom'

export type ToastKind = 'success' | 'error' | 'info';
export interface ToastItem { id: string; msg: string; kind: ToastKind; }

const TTL_MS = 3000;
let seq = 0;

export const pushToast = (list: ToastItem[], msg: string, kind: ToastKind): ToastItem[] =>
  [...list, { id: `t${++seq}`, msg, kind }];
export const dismissToast = (list: ToastItem[], id: string): ToastItem[] =>
  list.filter((t) => t.id !== id);

interface ToastActions {
  show: (msg: string, kind?: ToastKind) => void;
  dismiss: (id: string) => void;
}

export const toastAtom = atom<ToastItem[], ToastActions>(
  [],
  (get, set) => {
    const dismiss = (id: string) => set(dismissToast(get(), id));
    const show = (msg: string, kind: ToastKind = 'success') => {
      const next = pushToast(get(), msg, kind);
      const id = next[next.length - 1].id;
      set(next);
      window.setTimeout(() => dismiss(id), TTL_MS);
    };
    return { show, dismiss };
  },
);

/** 组件里取 show：`const toast = useToast(); toast('已绑定')` */
export const useToast = (): ToastActions['show'] => {
  const [, actions] = toastAtom.use();
  return actions.show;
};
