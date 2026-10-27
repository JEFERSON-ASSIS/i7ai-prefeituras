import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type SgdmNames = { agentes: Record<string, string>; conversas: Record<string, string | null> };

/** Resolves agent names and conversation titles for the Central (never message content). */
@Injectable()
export class SgdmNamesService {
  private readonly logger = new Logger(SgdmNamesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async resolve(agentIds: string[], conversationIds: string[]): Promise<SgdmNames> {
    const [agents, conversations] = await Promise.all([
      agentIds.length ? this.prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : [],
      conversationIds.length ? this.prisma.conversation.findMany({ where: { id: { in: conversationIds } }, select: { id: true, title: true } }) : [],
    ]);
    this.logger.log(`names lookup: agentes=${agentIds.length} conversas=${conversationIds.length}`);
    return {
      agentes: Object.fromEntries(agents.map(row => [row.id, row.name])),
      conversas: Object.fromEntries(conversations.map(row => [row.id, row.title ?? null])),
    };
  }
}
