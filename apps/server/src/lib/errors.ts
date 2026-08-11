/**
 * Central error handling. Every error becomes a stable `{ code, params,
 * traceId }` envelope (ТЗ §4.2). The frontend localizes `code`; raw messages
 * never cross the boundary as user-facing text.
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import { ErrorCodes, isAppError, randomToken, toAppError, type Logger } from '@neotavern/shared';

interface ValidationIssueShape {
  instancePath?: string;
  message?: string;
}

export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const traceId = randomToken(8);

    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      void reply.code(413).send({
        code: ErrorCodes.FILE_TOO_LARGE,
        params: { limitBytes: 25 * 1024 * 1024 },
        traceId,
      });
      return;
    }

    // JSON body over the API limit (ТЗ §13) — typed code, not INTERNAL.
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply.code(413).send({
        code: ErrorCodes.FILE_TOO_LARGE,
        params: { limitBytes: 4 * 1024 * 1024 },
        traceId,
      });
      return;
    }

    // Fastify schema validation failure (checked before the generic 4xx
    // branch: validation errors carry statusCode 400 but deserve the typed
    // VALIDATION envelope with per-field issues).
    if (error.validation) {
      const issues = (error.validation as ValidationIssueShape[]).slice(0, 20).map((v) => ({
        path: v.instancePath || '/',
        message: v.message ?? 'invalid',
      }));
      void reply.code(422).send({ code: ErrorCodes.VALIDATION, params: { issues }, traceId });
      return;
    }

    // Other Fastify-native client errors (malformed JSON body, unsupported
    // content type, …) keep their 4xx status and a typed code instead of
    // falling through to INTERNAL/500 (ТЗ §4.2 machine-readable envelope).
    if (
      !isAppError(error) &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      void reply.code(error.statusCode).send({
        code: ErrorCodes.BAD_REQUEST,
        params: { reason: typeof error.code === 'string' ? error.code : 'REQUEST_INVALID' },
        traceId,
      });
      return;
    }

    const appError = isAppError(error) ? error : toAppError(error);
    if (appError.httpStatus >= 500) {
      // The real logging sink with secret redaction is the app logger:
      // Fastify runs with logger:false, so request.log is a no-op and 5xx
      // errors used to be invisible in server.log (PROV-31).
      logger.error(appError.message, {
        code: appError.code,
        traceId,
        path: request.url,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : undefined,
      });
    }
    void reply
      .code(appError.httpStatus)
      .send({ code: appError.code, params: appError.params, traceId });
  });
}
