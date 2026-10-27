import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { THEMES, THEME_VERSION, ThemeId, themeLabel } from './themes';

export type SgdmThemes = {
  periodo: { inicio: string; fim: string };
  temas: { tema: ThemeId; rotulo: string; conversas: number; usuarios: number; prefeituras: number }[];
  semTema: number;
};

/** Conversation counts per theme for the Central (ids and counts only, never titles or messages). */
@Injectable()
export class SgdmThemesService {
  private readonly logger = new Logger(SgdmThemesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async themes(input: { inicio: string; fim: string; from: Date; to: Date; tenantId?: string }): Promise<SgdmThemes> {
    const tenant = input.tenantId ? Prisma.sql`AND "tenantId" = ${input.tenantId}::uuid` : Prisma.empty;
    const [rows, stale] = await Promise.all([
      this.prisma.$queryRaw<Array<{ theme: string; conversas: bigint; usuarios: bigint; prefeituras: bigint }>>(Prisma.sql`
        SELECT "theme", count(*)::bigint AS conversas, count(DISTINCT "userId")::bigint AS usuarios, count(DISTINCT "tenantId")::bigint AS prefeituras
        FROM conversations
        WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to} ${tenant}
          AND "themeVersion" >= ${THEME_VERSION} AND "theme" IS NOT NULL
        GROUP BY "theme"
      `),
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT count(*)::bigint AS total FROM conversations
        WHERE "createdAt" >= ${input.from} AND "createdAt" < ${input.to} ${tenant}
          AND ("themeVersion" < ${THEME_VERSION} OR "theme" IS NULL)
      `),
    ]);
    const order = new Map<string, number>(THEMES.map((theme, index) => [theme.id, index]));
    const temas = rows
      .map(row => ({ tema: row.theme as ThemeId, rotulo: themeLabel(row.theme), conversas: Number(row.conversas), usuarios: Number(row.usuarios), prefeituras: Number(row.prefeituras) }))
      .filter(row => row.conversas > 0)
      .sort((a, b) => b.conversas - a.conversas || (order.get(a.tema) ?? 99) - (order.get(b.tema) ?? 99));
    const semTema = Number(stale[0]?.total ?? 0);
    this.logger.log(`themes: temas=${temas.length} semTema=${semTema}`);
    return { periodo: { inicio: input.inicio, fim: input.fim }, temas, semTema };
  }
}
