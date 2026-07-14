const PRIORITY_ORDER = new Map(['P0', 'P1', 'P2', 'P3'].map((value, index) => [value, index]));

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN');
}

function compareTasks(left, right) {
  const priority = (PRIORITY_ORDER.get(left.priority) ?? 4) - (PRIORITY_ORDER.get(right.priority) ?? 4);
  if (priority) return priority;

  const deadline = Number(left.deadline ?? Number.MAX_SAFE_INTEGER)
    - Number(right.deadline ?? Number.MAX_SAFE_INTEGER);
  return deadline || compareText(left.name, right.name) || compareText(left.recordId, right.recordId);
}

function readOnlyTask(task) {
  const { action: _action, button: _button, ...readOnly } = task;
  return readOnly;
}

export function createReminderService({ base, members }) {
  return {
    async buildPlan(window) {
      const memberRows = await members.refresh();
      const tasks = await base.listDueTasks(window);
      const memberByOpenId = new Map(memberRows.map((member) => [member.openId, member]));
      const tasksByOwner = new Map();

      for (const task of tasks) {
        const ownerTasks = tasksByOwner.get(task.ownerOpenId) || [];
        ownerTasks.push(task);
        tasksByOwner.set(task.ownerOpenId, ownerTasks);
      }

      const ownerRows = [...tasksByOwner].map(([openId, ownerTasks]) => {
        const member = memberByOpenId.get(openId);
        return {
          openId,
          name: member?.name || ownerTasks[0]?.ownerName || openId,
          member,
          tasks: [...ownerTasks].sort(compareTasks),
        };
      }).sort((left, right) => compareText(left.name, right.name) || compareText(left.openId, right.openId));

      const ownerByOpenId = new Map(ownerRows.map((owner) => [owner.openId, owner]));
      const leaderTasks = new Map();
      const warnings = [];
      for (const owner of ownerRows) {
        if (!owner.member) {
          warnings.push({ ownerOpenId: owner.openId, reason: 'member_not_found' });
          continue;
        }

        const leaderOpenIds = await members.leadersByOwner(owner.openId);
        for (const leaderOpenId of leaderOpenIds) {
          const owners = leaderTasks.get(leaderOpenId) || new Map();
          owners.set(owner.openId, owner.tasks.map(readOnlyTask));
          leaderTasks.set(leaderOpenId, owners);
        }
      }

      return {
        owners: ownerRows.map(({ openId, tasks: ownerTasks }) => ({ openId, tasks: ownerTasks })),
        leaders: [...leaderTasks].sort(([left], [right]) => compareText(left, right))
          .map(([openId, owners]) => ({
            openId,
            owners: [...owners].map(([ownerOpenId, ownerTasks]) => ({
              openId: ownerOpenId,
              name: ownerByOpenId.get(ownerOpenId).name,
              tasks: ownerTasks,
            })),
          })),
        warnings,
      };
    },
  };
}
