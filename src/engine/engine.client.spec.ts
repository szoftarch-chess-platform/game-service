import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EngineClient } from './engine.client';
import { AppConfigService } from '../config/config.service';

describe('EngineClient', () => {
  let client: EngineClient;
  const mockConfig = {
    engineUrl: 'http://engine-service:8000',
  } as AppConfigService;

  beforeEach(() => {
    client = new EngineClient(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully returns a move on 200 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ move: 'e7e5' }),
    } as any);

    const result = await client.requestMove('some-fen');
    expect(result.success).toBe(true);
    expect(result.move).toBe('e7e5');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 400 or 422 client errors', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
    } as any);

    const result = await client.requestMove('some-fen');
    expect(result.success).toBe(false);
    expect(result.error).toContain('422');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries once on 500 error and succeeds if second attempt returns 200', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ move: 'd7d5' }),
      } as any);

    const result = await client.requestMove('some-fen');
    expect(result.success).toBe(true);
    expect(result.move).toBe('d7d5');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails after two attempts if 500 persists', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    const result = await client.requestMove('some-fen');
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
