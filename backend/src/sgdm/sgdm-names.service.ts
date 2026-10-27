import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { maskPersonalData } from './personal-data';
import { THEME_VERSION, ThemeId, classifyTheme, themeLabel } from './themes';

export type SgdmNames = { agentes: Record<string, string>; conversas: Record<string, string | null>; temas: Record<string, { id: ThemeId; rotulo: string }> };

/** Resolves agent names and conversation titles for the Central (never message content). */
@Injectable()
export class SgdmNamesService {
  private readonly logger = new Logger(SgdmNamesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async resolve(agentIds: string[], conversationIds: string[]): Promise<SgdmNames> {
    const [agents, conversations] = await Promise.all([
      agentIds.length ? this.prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : [],
      conversationIds.length ? this.prisma.conversation.findMany({ where: { id: { in: conversationIds } }, select: { id: true, title: true, theme: true, themeVersion: true, agent: { select: { name: true } } } }) : [],
    ]);
    this.logger.log(`names lookup: agentes=${agentIds.length} conversas=${conversationIds.length}`);
    // Titles leave i7Ai masked; a stale theme is classified on the fly and never written here.
    const temas: SgdmNames['temas'] = {};
    for (const row of conversations) {
      const id = (row.themeVersion >= THEME_VERSION && row.theme ? row.theme : classifyTheme(row.title, row.agent?.name ?? '')) as ThemeId;
      temas[row.id] = { id, rotulo: themeLabel(id) };
    }
    return {
      agentes: Object.fromEntries(agents.map(row => [row.id, row.name])),
      conversas: Object.fromEntries(conversations.map(row => [row.id, row.title == null ? null : maskPersonalData(row.title)])),
      temas,
    };
  }
}
