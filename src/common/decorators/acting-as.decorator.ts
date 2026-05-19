import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const ACTING_AS_HEADER = 'x-acting-as';

export const ActingAs = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | null => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const header = req.headers[ACTING_AS_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return null;
});
