import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type SgdmResearch = {
  periodo: { inicio: string; fim: string };
  total: number;
  custoUsd: number;
  porPrefeitura: { tenantId: string; pesquisas: number; internet: number; compras: number; custoUsd: number }[];
};

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Successful research calls per prefeitura for the Central (counts and cost only, never terms or results). */
@Injectable()
export class SgdmResearchService {
  private readonly logger = new Logger(SgdmResearchService.name);
  constructor(private readonly prisma: PrismaService) {}

  async research(input: { inicio: string; fim: string; from: Date; to: Date; tenantId?: string }): Promise<SgdmResearch> {
    const tenant = input.tenantId ? Prisma.sql`AND "tenantId" = ${input.tenantId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ tenantId: string; internet: bigint; compras: bigint; custo: Prisma.Decimal | number | string | null }>>(Prisma.sql`
      SELECT "tenantId"::text AS "tenantId",
             count(*) FILTER (WHERE "source" = 'web')::bigint AS internet,
             count(*) FILTER (WHERE "source" = 'pncp')::bigint AS compras,
             COALESCE(sum("costUsd"), 0) AS custo
      FROM research_calls
      WHERE "status" = 'ok' AND "createdAt" >= ${input.from} AND "createdAt" < ${input.to} ${tenant}
      GROUP BY "tenantId"
    `);
    const porPrefeitura = rows
      .map(row => {
        const internet = Number(row.internet); const compras = Number(row.compras);
        return { tenantId: row.tenantId, pesquisas: internet + compras, internet, compras, custoUsd: round(Number(row.custo ?? 0)) };
      })
      .filter(row => row.pesquisas > 0)
      .sort((a, b) => b.pesquisas - a.pesquisas || a.tenantId.localeCompare(b.tenantId));
    this.logger.log(`research: prefeituras=${porPrefeitura.length}`);
    return {
      periodo: { inicio: input.inicio, fim: input.fim },
      total: porPrefeitura.reduce((sum, row) => sum + row.pesquisas, 0),
      custoUsd: round(porPrefeitura.reduce((sum, row) => sum + row.custoUsd, 0)),
      porPrefeitura,
    };
  }
}
