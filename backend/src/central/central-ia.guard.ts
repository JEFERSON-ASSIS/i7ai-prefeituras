import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

/** Runs after JwtAuthGuard: the platform check answers 403 before any pipe validates the id or body. */
@Injectable()
export class CentralIaGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.centralIa) throw new ForbiddenException('Acesso restrito à Central de IA.');
    return true;
  }
}
