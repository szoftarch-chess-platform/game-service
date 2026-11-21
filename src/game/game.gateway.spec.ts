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

  describe('handleConnection', () => {
    it('authenticates and joins user room when identity headers are present', () => {
      gateway.handleConnection(mockSocket);
      expect(mockSocket.join).toHaveBeenCalledWith('user:0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f');
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects socket if identity headers are missing', () => {
      mockSocket.handshake.headers = {};
      gateway.handleConnection(mockSocket);
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
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
      const res = await gateway.handleMakeMove(mockSocket, { gameId: 'g1', move: 'e2e4' });
      expect(res.ok).toBe(true);
      expect(mockGameService.makeMove).toHaveBeenCalledWith(
        '0193c2b4-7d3e-7c2a-9f1e-3b5a6c7d8e9f',
        'g1',
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
