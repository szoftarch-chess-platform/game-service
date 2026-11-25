import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';

describe('GameGateway', () => {
  let gateway: GameGateway;
  let mockGameService: any;
  let mockSocket: any;

  beforeEach(() => {
    mockGameService = {
      setServer: vi.fn(),
      joinQueue: vi.fn().mockResolvedValue({ ok: true }),
      leaveQueue: vi.fn().mockResolvedValue({ ok: true }),
      startBotGame: vi.fn().mockResolvedValue({ ok: true }),
      makeMove: vi.fn().mockResolvedValue({ ok: true }),
      resign: vi.fn().mockResolvedValue({ ok: true }),
      getState: vi.fn().mockResolvedValue({ ok: true, queued: false }),
    };

    gateway = new GameGateway(mockGameService as GameService);

    mockSocket = {
      id: 'socket-1',
      handshake: {
        headers: {
          'x-user-id': '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
          'x-user-name': 'alice',
        },
      },
      data: {
        userId: '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
        userName: 'alice',
      },
      join: vi.fn(),
      disconnect: vi.fn(),
    };
  });

  describe('afterInit & auth middleware', () => {
    it('registers Socket.IO middleware that validates headers and sets socket data', () => {
      let middleware: any;
      const mockServer = {
        use: vi.fn((fn) => {
          middleware = fn;
        }),
      };
      gateway.afterInit(mockServer as any);
      expect(mockServer.use).toHaveBeenCalled();
      expect(mockGameService.setServer).toHaveBeenCalledWith(mockServer);

      const next = vi.fn();
      const testSocket = {
        handshake: {
          headers: {
            'x-user-id': '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
            'x-user-name': 'alice',
          },
        },
        data: {},
      };
      middleware(testSocket, next);
      expect(next).toHaveBeenCalledWith();
      expect(testSocket.data).toEqual({
        userId: '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
        userName: 'alice',
      });
    });

    it('rejects handshake with unauthorized error when identity headers are missing', () => {
      let middleware: any;
      const mockServer = {
        use: vi.fn((fn) => {
          middleware = fn;
        }),
      };
      gateway.afterInit(mockServer as any);

      const next = vi.fn();
      const unauthSocket = {
        handshake: { headers: {} },
        data: {},
      };
      middleware(unauthSocket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('unauthorized');
    });
  });

  describe('handleConnection', () => {
    it('authenticates and joins user room when identity headers are present', () => {
      gateway.handleConnection(mockSocket);
      expect(mockSocket.join).toHaveBeenCalledWith(
        'user:0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
      );
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects socket if identity headers are missing', () => {
      mockSocket.handshake.headers = {};
      mockSocket.data = {};
      gateway.handleConnection(mockSocket);
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('handleDisconnect', () => {
    it('removes user from queue when no remaining connections exist', async () => {
      const mockServer = {
        in: vi.fn().mockReturnValue({
          fetchSockets: vi.fn().mockResolvedValue([]),
        }),
      };
      gateway.server = mockServer as any;

      await gateway.handleDisconnect(mockSocket);
      expect(mockServer.in).toHaveBeenCalledWith(
        'user:0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
      );
      expect(mockGameService.leaveQueue).toHaveBeenCalledWith(
        '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
      );
    });

    it('does not remove user from queue if other connections remain in user room', async () => {
      const mockServer = {
        in: vi.fn().mockReturnValue({
          fetchSockets: vi.fn().mockResolvedValue([{ id: 'other-socket' }]),
        }),
      };
      gateway.server = mockServer as any;

      await gateway.handleDisconnect(mockSocket);
      expect(mockGameService.leaveQueue).not.toHaveBeenCalled();
    });

    it('handles errors during disconnect cleanup gracefully without throwing', async () => {
      const mockServer = {
        in: vi.fn().mockReturnValue({
          fetchSockets: vi
            .fn()
            .mockRejectedValue(new Error('Redis connection lost')),
        }),
      };
      gateway.server = mockServer as any;

      await expect(gateway.handleDisconnect(mockSocket)).resolves.not.toThrow();
    });

    it('ignores disconnect when userId is missing', async () => {
      const noUserSocket = { data: {}, handshake: { headers: {} } } as any;
      await expect(
        gateway.handleDisconnect(noUserSocket),
      ).resolves.not.toThrow();
      expect(mockGameService.leaveQueue).not.toHaveBeenCalled();
    });
  });

  describe('Payload validation', () => {
    it('rejects makeMove if payload is malformed', async () => {
      const res = await gateway.handleMakeMove(mockSocket, { gameId: 'g1' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('invalidPayload');
      }
    });

    it('delegates valid makeMove to service', async () => {
      const validGameId = '0193c2bf-0a1b-7c2d-9e3f-4a5b6c7d8e9f';
      const res = await gateway.handleMakeMove(mockSocket, {
        gameId: validGameId,
        move: 'e2e4',
      });
      expect(res.ok).toBe(true);
      expect(mockGameService.makeMove).toHaveBeenCalledWith(
        '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
        validGameId,
        'e2e4',
      );
    });

    it('rejects resign if gameId is missing', async () => {
      const res = await gateway.handleResign(mockSocket, {});
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('invalidPayload');
      }
    });
  });
});
