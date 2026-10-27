import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class InsightsController {
  constructor(private readonly prisma:PrismaService) {}
  @Get('dashboard')
  @RequirePermission('dashboard','read')
  dashboard(@Req() req:AuthenticatedRequest) { return this.summary(req.user!.tenantId); }
  @Get('reports')
  @RequirePermission('reports','read')
  reports(@Req() req:AuthenticatedRequest) { return this.summary(req.user!.tenantId); }
  @Get('audit')
  @RequirePermission('reports','read')
  audit(@Req() req:AuthenticatedRequest) {
    return this.prisma.auditLog.findMany({where:{tenantId:req.user!.tenantId},take:100,orderBy:{createdAt:'desc'},include:{user:{select:{name:true,email:true}}}});
  }
  private async summary(tenantId:string) {
    const from=new Date();from.setUTCDate(from.getUTCDate()-30);
    // Answers served from the exact cache are left out of the token totals and counted apart (cacheHits).
    const [agents,conversations,automations,documents,usage,models,daily,recent,executions,cacheHits] = await Promise.all([
      this.prisma.agent.count({where:{tenantId,status:'ACTIVE'}}),
      this.prisma.conversation.count({where:{tenantId}}),
      this.prisma.automation.count({where:{tenantId,status:'ACTIVE'}}),
      this.prisma.document.count({where:{tenantId,status:'READY'}}),
      this.prisma.aiUsage.aggregate({where:{tenantId,createdAt:{gte:from},cacheHit:false},_sum:{inputTokens:true,outputTokens:true,cost:true},_count:true}),
      this.prisma.aiUsage.groupBy({by:['modelId'],where:{tenantId,createdAt:{gte:from},cacheHit:false},_sum:{inputTokens:true,outputTokens:true,cost:true},_count:true}),
      this.prisma.$queryRaw<Array<{date:string;inputTokens:bigint;outputTokens:bigint}>>(Prisma.sql`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Cuiaba','YYYY-MM-DD') AS date,
          SUM("inputTokens")::bigint AS "inputTokens", SUM("outputTokens")::bigint AS "outputTokens"
        FROM ai_usage WHERE "tenantId"=${tenantId}::uuid AND "createdAt">=${from} AND NOT "cacheHit"
        GROUP BY date ORDER BY date
      `),
      this.prisma.auditLog.findMany({where:{tenantId},take:8,orderBy:{createdAt:'desc'}}),
      this.prisma.automationExecution.groupBy({by:['status'],where:{tenantId,createdAt:{gte:from}},_count:true}),
      this.prisma.aiUsage.count({where:{tenantId,createdAt:{gte:from},cacheHit:true}}),
    ]);
    const catalog=await this.prisma.aiModel.findMany({where:{id:{in:models.map(item=>item.modelId).filter((id):id is string=>!!id)}},include:{provider:true}});
    return {
      from:from.toISOString(),timezone:'America/Cuiaba',agents,conversations,automations,documents,
      inputTokens:usage._sum.inputTokens||0,outputTokens:usage._sum.outputTokens||0,cost:Number(usage._sum.cost||0),requests:usage._count,cacheHits,
      daily:daily.map(item=>({...item,inputTokens:Number(item.inputTokens),outputTokens:Number(item.outputTokens)})),
      models:models.map(item=>{const model=catalog.find(model=>model.id===item.modelId);return {modelId:item.modelId,name:model?.name||'Modelo não identificado',provider:model?.provider.name||'Gateway',inputTokens:item._sum.inputTokens||0,outputTokens:item._sum.outputTokens||0,cost:Number(item._sum.cost||0),costConfigured:model?.inputPrice!=null&&model?.outputPrice!=null,requests:item._count};}),
      recent,executions:executions.map(item=>({status:item.status,count:item._count})),
    };
  }
}
