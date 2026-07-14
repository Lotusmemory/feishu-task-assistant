import { randomUUID } from 'node:crypto';

export function createConfirmationStore({
  store, ttlMs, clock = Date.now, idFactory = randomUUID,
}) {
  return {
    async create(actorOpenId, action) {
      const id = idFactory();
      const createdAt = clock();
      await store.update((state) => ({
        ...state,
        confirmations: {
          ...(state.confirmations || {}),
          [id]: {
            actorOpenId,
            action: structuredClone(action),
            createdAt,
            expiresAt: createdAt + ttlMs,
            status: 'pending',
            startedAt: null,
            succeededAt: null,
            failedAt: null,
          },
        },
      }));
      return id;
    },

    async get(id, actorOpenId) {
      const item = (await store.read()).confirmations?.[id];
      if (!item || item.actorOpenId !== actorOpenId
        || !['pending', 'failed'].includes(item.status) || item.expiresAt <= clock()) return null;
      return structuredClone(item);
    },

    async begin(id, actorOpenId) {
      let action = null;
      await store.update((state) => {
        const item = state.confirmations?.[id];
        const now = clock();
        if (!item || item.actorOpenId !== actorOpenId
          || !['pending', 'failed'].includes(item.status) || item.expiresAt <= now) return state;
        action = structuredClone(item.action);
        return {
          ...state,
          confirmations: {
            ...state.confirmations,
            [id]: { ...item, status: 'executing', startedAt: now, failedAt: null },
          },
        };
      });
      return action;
    },

    async markSucceeded(id, actorOpenId) {
      await store.update((state) => {
        const item = state.confirmations?.[id];
        if (!item || item.actorOpenId !== actorOpenId || item.status !== 'executing') return state;
        return {
          ...state,
          confirmations: {
            ...state.confirmations,
            [id]: { ...item, status: 'succeeded', succeededAt: clock() },
          },
        };
      });
    },

    async markFailed(id, actorOpenId) {
      await store.update((state) => {
        const item = state.confirmations?.[id];
        if (!item || item.actorOpenId !== actorOpenId || item.status !== 'executing') return state;
        return {
          ...state,
          confirmations: {
            ...state.confirmations,
            [id]: { ...item, status: 'failed', failedAt: clock() },
          },
        };
      });
    },
  };
}
