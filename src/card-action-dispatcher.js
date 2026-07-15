export function createCardActionDispatcher({
  confirmationAction,
  reminderAction,
  defer = queueMicrotask,
  logger = console,
}) {
  return (event) => {
    defer(async () => {
      try {
        const result = await confirmationAction(event);
        if (result?.kind === 'ignored') await reminderAction(event);
      } catch (error) {
        logger.error('Card action failed after acknowledgement', { error });
      }
    });

    return { toast: { type: 'info', content: '已收到，正在处理' } };
  };
}
