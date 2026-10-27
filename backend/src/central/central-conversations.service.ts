import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

export const MAX_OPEN_MESSAGES = 1000;
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

export interface CentralConversationView {
  id: string; titulo: string | null; prefeitura: string; agente: string; modelo: string | null;
  criadaEm: string; truncada: boolean;
  mensagens: { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; anexos: string[] }[];
}

/** Platform-owner access to any prefeitura's conversation: read-only and always audited in that prefeitura's log. */
@Injectable()
export class CentralConversationsService {
  private readonly logger = new Logger(CentralConversationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async open(viewer: AuthenticatedRequest['user'], id: string, motivo: string, ip?: string): Promise<CentralConversationView> {
    // First check, before any database read: the answer must not depend on whether the id exists.
    if (!viewer?.centralIa) throw new ForbiddenException('Acesso restrito à Central de IA.');

    const view = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id },
        select: {
          id: true, tenantId: true, title: true, createdAt: true,
          tenant: { select: { name: true } }, agent: { select: { name: true } }, model: { select: { slug: true } },
          messages: {
            orderBy: { createdAt: 'desc' }, take: MAX_OPEN_MESSAGES + 1,
            select: { id: true, role: true, content: true, createdAt: true, attachments: { select: { document: { select: { name: true } } } } },
          },
        },
      });
      if (!conversation) throw new NotFoundException('Conversa não encontrada.');

      const truncada = conversation.messages.length > MAX_OPEN_MESSAGES;
      const mensagens = conversation.messages.slice(0, MAX_OPEN_MESSAGES).reverse().map(message => ({
        id: message.id,
        // An unknown stored role is shown as 'system' so the view never carries a value outside the contract.
        role: ROLES.has(message.role) ? message.role as CentralConversationView['mensagens'][number]['role'] : 'system',
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        anexos: message.attachments.map(item => item.document.name),
      }));

      // Same transaction and before the response: if the audit cannot be written, nothing is returned.
      await tx.auditLog.create({
        data: {
          tenantId: conversation.tenantId, userId: viewer.sub, event: 'conversation.viewed_by_platform',
          resource: 'conversations', resourceId: conversation.id, ipAddress: ip ?? null,
          metadata: { viewerTenantId: viewer.tenantId, viewerEmail: viewer.email, motivo, origem: 'central-ia', mensagens: mensagens.length },
        },
      });

      return {
        id: conversation.id, titulo: conversation.title, prefeitura: conversation.tenant.name, agente: conversation.agent.name,
        modelo: conversation.model?.slug ?? null, criadaEm: conversation.createdAt.toISOString(), truncada, mensagens,
      } satisfies CentralConversationView;
    }, { timeout: 15_000 });

    // Counts only: never the reason, the title or the content.
    this.logger.log('Conversa ' + id + ' aberta pela Central de IA (' + view.mensagens.length + ' mensagens).');
    return view;
  }
}
