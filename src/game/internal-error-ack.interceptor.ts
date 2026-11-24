import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, of } from 'rxjs';
import { RejectedResponse } from '../domain/types';

export const INTERNAL_ERROR_ACK: RejectedResponse = {
  ok: false,
  error: { code: 'internalError', message: 'The game-service failed.' },
};

/**
 * Answers an event whose handler failed with the acknowledgement `internalError` of `game-service.asyncapi.yaml`.
 * Without it Nest sends only an `exception` event and no acknowledgement, so the client would wait for one forever.
 * The message tells nothing about the cause, which goes to the log.
 */
@Injectable()
export class InternalErrorAckInterceptor implements NestInterceptor {
  private readonly logger = new Logger(InternalErrorAckInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const event = context.switchToWs().getPattern();
        this.logger.error(
          `The event ${event} failed.`,
          error instanceof Error ? error.stack : String(error),
        );
        return of(INTERNAL_ERROR_ACK);
      }),
    );
  }
}
