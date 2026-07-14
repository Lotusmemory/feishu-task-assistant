export function extractPrompt(message) {
  if (message?.message_type !== 'text') return null;
  let parsed;
  try { parsed = JSON.parse(message.content); } catch { return null; }
  let text = typeof parsed.text === 'string' ? parsed.text : '';
  if (message.chat_type === 'group') {
    if (!Array.isArray(message.mentions) || message.mentions.length === 0) return null;
    for (const mention of message.mentions) {
      if (mention?.key) text = text.replaceAll(mention.key, '');
    }
  }
  text = text.trim();
  return text || null;
}
