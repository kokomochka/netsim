// Minimal reactive store (architecture v2, §1). Mutations happen in place inside
// update(); every change carries a reason tag so subscribers can skip work
// they don't care about (e.g. the config panel ignores camera moves).

export type ChangeReason = 'camera' | 'world' | 'ui' | 'load' | 'sim';
export type Listener<T> = (state: T, reason: ChangeReason) => void;

export interface Store<T> {
  get(): T;
  replace(next: T, reason?: ChangeReason): void;
  update(mutate: (draft: T) => void, reason?: ChangeReason): void;
  subscribe(fn: Listener<T>): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  const emit = (reason: ChangeReason) => {
    for (const fn of [...listeners]) fn(state, reason);
  };
  return {
    get: () => state,
    replace(next, reason = 'load') {
      state = next;
      emit(reason);
    },
    update(mutate, reason = 'world') {
      mutate(state);
      emit(reason);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
