import 'dotenv/config';
import { createEmbedder } from '../src/embedder.js';

const passages = [
  '标题：年假申请。适用问题：休年假、年假在哪里申请。正文：员工应提前在飞书提交请假申请，经直属主管审批后生效。',
  '标题：事假申请。适用问题：临时请事假。正文：临时有事不能到岗时，应尽快提交事假并通知直属主管。',
  '标题：费用报销。适用问题：普通费用、发票报销。正文：取得合规发票后，在报销系统填写用途、金额并提交审批。',
  '标题：差旅报销。适用问题：出差费用、行程单报销。正文：出差结束后上传行程单、发票和审批记录，再提交报销。',
  '标题：VPN 使用。适用问题：远程办公、在家连接公司内网。正文：在公司设备安装 VPN 客户端，使用员工账号完成双因素认证。',
  '标题：办公网络故障。适用问题：办公室 Wi-Fi 断网。正文：先检查网线或 Wi-Fi，再重启网络；仍失败时联系 IT。',
  '标题：系统权限申请。适用问题：开通业务系统、申请系统角色。正文：在权限平台选择系统和角色，由直属主管及系统负责人审批。',
  '标题：账号密码重置。适用问题：忘记密码、账号无法登录。正文：通过统一身份平台自助重置，无法验证身份时联系 IT。',
  '标题：合同审批。适用问题：发起合同审核、法务审合同。正文：上传合同正文和业务背景，依次经过法务、财务和负责人审批。',
  '标题：采购审批。适用问题：购买设备、供应商下单。正文：填写采购用途、供应商和预算，审批通过后才能下单。',
  '标题：项目交付。适用问题：交付验收、交付材料。正文：交付前完成验收清单、操作文档、培训和客户签字确认。',
  '标题：项目立项。适用问题：新项目启动、立项审批。正文：明确目标、范围、负责人、时间和预算后提交立项审批。',
];

const cases = [
  ['我想休年假要走什么流程', 0], ['年假在哪里申请', 0],
  ['拿到发票之后怎么报销', 2], ['普通费用报销需要什么', 2],
  ['在家办公怎样连接公司内网', 4], ['VPN 登录有什么要求', 4],
  ['怎么开通业务系统权限', 6], ['申请一个系统角色', 6],
  ['合同要找哪些人审批', 8], ['发起合同审核需要什么', 8],
  ['项目交付前要准备哪些材料', 10], ['交付验收有哪些步骤', 10],
];

const unknownQueries = ['食堂今天吃什么', '附近哪里可以停车', '股票能买吗', '周末天气如何', '帮我写一首诗', '世界杯赛程'];

const embedder = createEmbedder({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseUrl: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
  model: process.env.SILICONFLOW_EMBEDDING_MODEL || 'BAAI/bge-m3',
});
const passageVectors = await embedder.embedPassages(passages);
let passed = 0;
const margins = [];

for (const [query, expected] of cases) {
  const queryVector = await embedder.embedQuery(query);
  const scores = passageVectors.map((vector) => vector.reduce((sum, value, i) => sum + value * queryVector[i], 0));
  const ranked = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
  const positive = scores[expected];
  const bestNegative = Math.max(...scores.filter((_score, index) => index !== expected));
  if (ranked[0].index === expected) passed += 1;
  margins.push({ positive, bestNegative });
  console.log(JSON.stringify({ query, expected, top: ranked[0].index, positive, bestNegative }));
}

const minPositive = Math.min(...margins.map(({ positive }) => positive));
const maxNegative = Math.max(...margins.map(({ bestNegative }) => bestNegative));
const unknownTopScores = [];
for (const query of unknownQueries) {
  const queryVector = await embedder.embedQuery(query);
  const top = Math.max(...passageVectors.map((vector) => vector.reduce((sum, value, i) => sum + value * queryVector[i], 0)));
  unknownTopScores.push(top);
  console.log(JSON.stringify({ unknown: query, top }));
}
const maxUnknown = Math.max(...unknownTopScores);
console.log(JSON.stringify({ passed, total: cases.length, minPositive, maxNegative, maxUnknown }));
if (passed !== cases.length) process.exitCode = 1;
