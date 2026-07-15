import React, { createContext, useContext, useMemo } from 'react';
import type { FC, PropsWithChildren } from 'react';
import { unit as generate } from './unit.js';
import type { Change, Listen } from './unit.js';

const uuid = () => Math.round((Math.random() + 1) * Date.now()).toString(36);
const UNIQ = Symbol('BUILD');

type Creator<T, A> = (get: () => T, set: Change<T>, use: UseAtom) => A;
interface ReadonlyState<T> {
  get: () => T;
  listen: Listen<T>;
  use: () => T;
}
interface ValueState<T> extends ReadonlyState<T> {
  change: Change<T>;
}
interface ActionState<T, A> extends ReadonlyState<T> {
  actions: A;
}
export type AnyAtom<T = unknown> = ValueAtom<T> | ActionAtom<T, unknown> | ComputedAtom<T>;
export interface Query {
  <T>(atom: ComputedAtom<T>): ReadonlyState<T>;
  <T, A>(atom: ActionAtom<T, A>): ActionState<T, A>;
  <T>(atom: ValueAtom<T>): ValueState<T>;
  <T>(atom: AnyAtom<T>): ReadonlyState<T>;
}
export interface UseAtom {
  <T>(atom: ComputedAtom<T>): T;
  <T, A>(atom: ActionAtom<T, A>): [T, A];
  <T>(atom: ValueAtom<T>): [T, Change<T>];
}
export type UseData = <T>(atom: AnyAtom<T>) => T;

class ValueAtom<T> {
  public readonly type = 'v' as const;
  public readonly key = uuid();
  public proxy?: (get: () => T, set: Change<T>) => Change<T>;
  constructor(private init: T) {}

  public [UNIQ](_query: Query): ValueState<T> {
    const state = generate(this.init);
    if (this.proxy) {
      state.change = this.proxy(state.get, state.change);
    }
    return state;
  }

  public useData(): T {
    return useContext(Context)(this).use();
  }

  public use(): [T, Change<T>] {
    const { use, change } = useContext(Context)(this);
    return [use(), change];
  }

  public useChange(): Change<T> {
    return useContext(Context)(this).change;
  }
}

const _q_2_u_ = new WeakMap<Query, UseAtom>();
function buildUseFromQuery(query: Query): UseAtom {
  const cached = _q_2_u_.get(query);
  if (cached) return cached;
  function use(atom: AnyAtom) {
    switch (atom.type) {
      case 'c':
        return query(atom).get();
      case 'v': {
        const { get, change } = query(atom);
        return [get(), change];
      }
      case 'a': {
        const { get, actions } = query(atom);
        return [get(), actions];
      }
    }
  }
  // `use` 的运行时派发与 UseAtom 重载一一对应，但 TS 无法从联合实现推回重载签名。
  const typed = use as unknown as UseAtom;
  _q_2_u_.set(query, typed);
  return typed;
}

class ActionAtom<T, A> {
  public readonly type = 'a' as const;
  public readonly key = uuid();
  constructor(
    private readonly init: T,
    private readonly creator: Creator<T, A>,
  ) {}

  public [UNIQ](query: Query): ActionState<T, A> {
    const state = generate(this.init);
    const use = buildUseFromQuery(query);
    const actions = this.creator(state.get, state.change, use);
    return Object.assign(state, { actions });
  }

  public useData(): T {
    return useContext(Context)(this).use();
  }

  public use(): [T, A] {
    const { use, actions } = useContext(Context)(this);
    return [use(), actions];
  }

  public useChange(): A {
    return useContext(Context)(this).actions;
  }
}

class ComputedAtom<T> {
  public readonly type = 'c' as const;
  public readonly key = uuid();
  constructor(private readonly calc: (use: UseData) => T) {}

  public [UNIQ](query: Query): ReadonlyState<T> {
    const deps: AnyAtom[] = [];
    // 首跑收集依赖：泛型擦除后 get() 的运行时值即对应 atom 的值。
    let collect = ((atom: AnyAtom) => (deps.push(atom), query(atom).get())) as UseData;
    const state = generate(this.calc(collect));
    if (deps.length > 0) {
      collect = ((atom: AnyAtom) => query(atom).get()) as UseData;
      const update = () => state.change(this.calc(collect));
      deps.forEach((a) => query(a).listen(update));
    }
    return state;
  }

  public use(): T {
    return useContext(Context)(this).use();
  }
}

export function atom<T>(initial: (use: UseData) => T): ComputedAtom<T>;
export function atom<T, A>(initial: T, creator: Creator<T, A>): ActionAtom<T, A>;
export function atom<T>(initial: T): ValueAtom<T>;
export function atom(a: unknown, b?: unknown) {
  if (typeof a === 'function') return new ComputedAtom(a as (use: UseData) => unknown);
  if (b) return new ActionAtom(a, b as Creator<unknown, unknown>);
  return new ValueAtom(a);
}

function build(): Query {
  const map = new Map<string, ReadonlyState<unknown>>();
  // 异构 state 表按 key 缓存；Query 重载在消费点恢复精确类型。
  const query = ((atom: AnyAtom): ReadonlyState<unknown> => {
    const hit = map.get(atom.key);
    if (hit) return hit;
    const built = atom[UNIQ](query);
    map.set(atom.key, built);
    return built;
  }) as unknown as Query;
  return query;
}
const Context = createContext(build());
const Root = Context.Provider;
export const WithStore: FC<PropsWithChildren> = (p) => <Root value={useMemo(build, [])}>{p.children}</Root>;

export function mutate<T extends Function>(init: (use: UseAtom) => T) {
  const cache = new WeakMap<Query, T>();
  return {
    use(): T {
      const query = useContext(Context);
      const hit = cache.get(query);
      if (hit) return hit;
      const result = init(buildUseFromQuery(query));
      cache.set(query, result);
      return result;
    },
  };
}
