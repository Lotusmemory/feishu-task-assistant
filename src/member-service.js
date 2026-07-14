export function createMemberService({ base }) {
  let cache = null;
  return {
    async refresh() { cache = await base.listMembers(); return cache; },
    async leadersByOwner(openId) {
      const members = cache || await this.refresh();
      return members.find((item) => item.openId === openId)?.leaderOpenIds || [];
    },
    async resolveByName(name) {
      const members = cache || await this.refresh();
      return members.filter((item) => item.name === name);
    },
  };
}
