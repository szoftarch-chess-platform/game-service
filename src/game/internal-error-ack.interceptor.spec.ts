import { describe, it, expect, vi, afterEach } from 'vitest';
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  INTERNAL_ERROR_ACK,
  InternalErrorAckInterceptor,
} from './internal-error-ack.interceptor';

function contextOf(event: string): ExecutionContext {
  return {
    switchToWs: () => ({ getPattern: () => event }),
  } as unknown as ExecutionContext;
}

describe('InternalErrorAckInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a failed handler with internalError and logs the cause', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const next: CallHandler = {
      handle: () => throwError(() => new Error('Redis connection lost')),
    };

    const answer = await firstValueFrom(
      new InternalErrorAckInterceptor().intercept(contextOf('getState'), next),
    );

    expect(answer).toEqual({
      ok: false,
      error: { code: 'internalError', message: 'The game-service failed.' },
    });
    expect(answer).toBe(INTERNAL_ERROR_ACK);
    expect(log).toHaveBeenCalledWith(
      'The event getState failed.',
      expect.stringContaining('Redis connection lost'),
    );
  });

  it('passes the answer of a handler that worked', async () => {
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const answer = await firstValueFrom(
      new InternalErrorAckInterceptor().intercept(contextOf('makeMove'), next),
    );

    expect(answer).toEqual({ ok: true });
  });
});
