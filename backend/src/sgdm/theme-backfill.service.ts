import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { THEME_VERSION, ThemeId, classifyTheme } from './themes';

const FIRST_RUN_MS = 60_000;
const DEFAULT_INTERVAL_MS = 600_000;
export const THEME_BACKFILL_BATCH = 500;
export const THEME_BACKFILL_MAX_BATCHES = 20;

/** THEME_BACKFILL_INTERVAL_MS (default 10 min); 0 turns the job off; an invalid value keeps the default. */
export function themeBackfillInterval(raw = process.env.THEME_BACKFILL_INTERVAL_MS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : DEFAULT_INTERVAL_MS;
}

/**
 * Fills conversations.theme for rows whose themeVersion is behind THEME_VERSION (existing rows,
 * or all of them after the list changes). Idempotent: updated rows leave the filter, so each
 * batch simply reads the next ones. Logs counts only, never titles.
 */
@Injectable()
export class ThemeBackfillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ThemeBackfillService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopping = false;
  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    if (themeBackfillInterval() > 0) this.schedule(FIRST_RUN_MS);
  }

  private schedule(delay: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.run()
        .catch(() => this.logger.error('Falha no recálculo de temas das conversas; a próxima rodada tentará novamente.'))
        .finally(() => this.schedule(themeBackfillInterval()));
    }, delay);
    this.timer.unref();
  }

  async onModuleDestroy() { this.stopping = true; clearTimeout(this.timer); await this.running; }

  /** One round: up to 20 batches of 500 conversations. Returns how many rows were updated. */
  async run(): Promise<{ updated: number; batches: number }> {
    let updated = 0; let batches = 0;
    while (!this.stopping && batches < THEME_BACKFILL_MAX_BATCHES) {
      const rows = await this.prisma.conversation.findMany({
        where: { themeVersion: { lt: THEME_VERSION } },
        select: { id: true, title: true, agent: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: THEME_BACKFILL_BATCH,
      });
      if (!rows.length) break;
      batches++;
      const byTheme = new Map<ThemeId, string[]>();
      for (const row of rows) {
        const theme = classifyTheme(row.title, row.agent?.name ?? '');
        byTheme.set(theme, [...(byTheme.get(theme) || []), row.id]);
      }
      for (const [theme, ids] of byTheme) {
        // The version filter keeps a row already classified by a newer release from being overwritten.
        const result = await this.prisma.conversation.updateMany({ where: { id: { in: ids }, themeVersion: { lt: THEME_VERSION } }, data: { theme, themeVersion: THEME_VERSION } });
        updated += result.count;
      }
      if (rows.length < THEME_BACKFILL_BATCH) break;
    }
    if (updated) this.logger.log('Temas recalculados: ' + updated + ' conversas em ' + batches + ' lotes.');
    return { updated, batches };
  }
}
