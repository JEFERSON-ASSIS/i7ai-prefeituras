import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SgdmAgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string): Promise<{ agentes: { id: string; nome: string; status: string }[] }> {
    const rows = await this.prisma.agent.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true, name: true, status: true }, orderBy: { name: 'asc' } });
    return { agentes: rows.map(row => ({ id: row.id, nome: row.name, status: row.status })) };
  }
}
