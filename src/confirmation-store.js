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
            consumedAt: null,
          },
        },
      }));
      return id;
    },

    async get(id, actorOpenId) {
      const item = (await store.read()).confirmations?.[id];
      if (!item || item.actorOpenId !== actorOpenId || item.consumedAt !== null || item.expiresAt <= clock()) return null;
      return structuredClone(item);
    },

    async consume(id, actorOpenId) {
      let action = null;
      await store.update((state) => {
        const item = state.confirmations?.[id];
        const now = clock();
        if (!item || item.actorOpenId !== actorOpenId || item.consumedAt !== null || item.expiresAt <= now) return state;
        action = structuredClone(item.action);
        return {
          ...state,
          confirmations: {
            ...state.confirmations,
            [id]: { ...item, consumedAt: now },
          },
        };
      });
      return action;
    },
  };
}
