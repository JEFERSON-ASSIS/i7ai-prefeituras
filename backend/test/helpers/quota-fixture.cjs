const { randomUUID } = require('node:crypto');
const { AiQuotaService } = require('../../dist/ai/ai-quota.service');
function quotaFixture(prisma, records, limits) {
  const reservations = records.reservations = [];
  prisma.$queryRaw ||= async () => [];
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (key === 'createdAt') return row.createdAt >= value.gte;
    if (value && typeof value === 'object' && value.in) return value.in.includes(row[key]);
    return row[key] === value;
  });
  prisma.aiTokenReservation = {
    create: async ({data}) => { const row={id:randomUUID(),status:'RESERVED',...data};reservations.push(row);return row; },
    findFirst: async ({where}) => reservations.find(row=>matches(row,where)),
    findMany: async ({where}) => reservations.filter(row=>matches(row,where)),
    update: async ({where,data}) => Object.assign(reservations.find(row=>row.id===where.id),data),
    aggregate: async ({where}) => ({_sum:{reservedTokens:reservations.filter(row=>matches(row,where)).reduce((sum,row)=>sum+row.reservedTokens,0n)}}),
    count: async ({where}) => reservations.filter(row=>matches(row,where)).length,
  };
  prisma.aiUsage.findUnique=async ({where}) => records.usage.find(row=>row.id===where.id);
  prisma.aiUsage.upsert=async ({where,create,update}) => {
    const row=records.usage.find(row=>row.id===where.id);
    return row?Object.assign(row,update):prisma.aiUsage.create({data:create});
  };
  prisma.aiUsage.updateMany=async ({where,data}) => { const rows=records.usage.filter(row=>matches(row,where)); rows.forEach(row=>Object.assign(row,data));return {count:rows.length}; };
  prisma.aiUsage.aggregate ||= async ({where}) => ({_sum:records.usage.filter(row=>matches(row,where)).reduce((sum,row)=>({inputTokens:sum.inputTokens+row.inputTokens,outputTokens:sum.outputTokens+row.outputTokens,cost:sum.cost+Number(row.cost||0)}),{inputTokens:0,outputTokens:0,cost:0})});
  return new AiQuotaService(prisma, limits);
}
module.exports={quotaFixture};
