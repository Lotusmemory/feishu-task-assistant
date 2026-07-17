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

function tasksByOwner(tasks) {
  const grouped = new Map();
  for (const task of tasks) {
    const ownerTasks = grouped.get(task.ownerOpenId) || [];
    ownerTasks.push(task);
    grouped.set(task.ownerOpenId, ownerTasks);
  }
  return grouped;
}

function ownerRows(grouped, memberByOpenId) {
  return [...grouped].map(([openId, tasks]) => {
    const member = memberByOpenId.get(openId);
    return {
      openId,
      name: member?.name || tasks[0]?.ownerName || openId,
      member,
      tasks: [...tasks].sort(compareTasks),
    };
  }).sort((left, right) => compareText(left.name, right.name) || compareText(left.openId, right.openId));
}

export function createReminderService({ base, members }) {
  return {
    async buildPlan(window) {
      const memberRows = await members.refresh();
      const dueTasks = await base.listDueTasks(window);
      const leaderReportTasks = await base.listLeaderReportTasks(window);
      const memberByOpenId = new Map(memberRows.map((member) => [member.openId, member]));
      const reminderOwners = ownerRows(tasksByOwner(dueTasks), memberByOpenId);
      const reportOwners = ownerRows(tasksByOwner(leaderReportTasks), memberByOpenId);

      const leaderTasks = new Map();
      const warnings = [];
      for (const owner of reminderOwners) {
        if (!owner.member) {
          warnings.push({ ownerOpenId: owner.openId, reason: 'member_not_found' });
        }
      }
      for (const owner of reportOwners) {
        if (!owner.member) {
          if (!warnings.some(({ ownerOpenId }) => ownerOpenId === owner.openId)) {
            warnings.push({ ownerOpenId: owner.openId, reason: 'member_not_found' });
          }
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
        owners: reminderOwners.map(({ openId, tasks }) => ({ openId, tasks })),
        leaders: [...leaderTasks].sort(([left], [right]) => compareText(left, right))
          .map(([openId, owners]) => ({
            openId,
            owners: [...owners].map(([ownerOpenId, ownerTasks]) => ({
              openId: ownerOpenId,
              name: memberByOpenId.get(ownerOpenId)?.name || ownerOpenId,
              tasks: ownerTasks,
            })),
          })),
        warnings,
      };
    },
  };
}
