import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { CodedException, ErrorCodes, statusForCode, type ErrorCode } from '../constants/error-codes';

type ErrorBody = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | unknown[];
  requestId?: string;
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined;

    const body = this.normalize(exception);
    if (requestId) body.requestId = requestId;

    if (body.code === ErrorCodes.INTERNAL_ERROR) {
      this.logger.error({ err: exception, requestId }, 'unhandled error');
    } else {
      this.logger.warn({ err: exception, requestId, code: body.code }, 'handled error');
    }

    res.status(statusForCode(body.code)).json(body);
  }

  private normalize(exception: unknown): ErrorBody {
    if (exception instanceof CodedException) {
      return { code: exception.code, message: exception.code, details: exception.details };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const code = mapHttpStatusToCode(status);
      if (typeof response === 'string') {
        return { code, message: response };
      }
      const r = response as { message?: unknown; error?: string };
      return {
        code,
        message: typeof r.message === 'string' ? r.message : code,
        details: Array.isArray(r.message) ? r.message : undefined,
      };
    }
    return { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal server error' };
  }
}

function mapHttpStatusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCodes.VALIDATION_FAILED;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONFLICT;
    case 429:
      return ErrorCodes.RATE_LIMITED;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}
