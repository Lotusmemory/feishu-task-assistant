export function createDeduplicator() {
  const seen = new Set();
  return {
    claim(messageId) {
      if (!messageId || seen.has(messageId)) return false;
      seen.add(messageId);
      return true;
    },
  };
}
