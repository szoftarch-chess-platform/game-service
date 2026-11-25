import { Logger, UseInterceptors } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';
import { OperationResponse, StateResponse } from '../domain/types';
import { InternalErrorAckInterceptor } from './internal-error-ack.interceptor';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UCI_MOVE_REGEX = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function isObject(val: any): boolean {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function normalizePayload(data: any): any {
  if (
    typeof data === 'function' ||
    data === undefined ||
    data === null ||
    data === ''
  ) {
    return {};
  }
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

@WebSocketGateway({
  // The API gateway routes this path here and requires a valid token on it.
  path: '/ws/game',
  // Without long polling a connection needs no sticky session between the instances.
  transports: ['websocket'],
})
@UseInterceptors(InternalErrorAckInterceptor)
export class GameGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(private readonly gameService: GameService) {}

  afterInit(server: Server) {
    server.use((socket, next) => {
      const headers = socket.handshake.headers;
      const userId = headers['x-user-id'] as string | undefined;
      const userName = headers['x-user-name'] as string | undefined;

      if (!userId || !userName) {
        return next(new Error('unauthorized'));
      }

      socket.data = { ...socket.data, userId, userName };
      next();
    });

    this.gameService.setServer(server);
  }

  handleConnection(client: Socket) {
    const userId =
      (client.data?.userId as string | undefined) ??
      (client.handshake.headers['x-user-id'] as string | undefined);
    const userName =
      (client.data?.userName as string | undefined) ??
      (client.handshake.headers['x-user-name'] as string | undefined);

    if (!userId || !userName) {
      // Fallback disconnect if bypassed middleware
      client.disconnect(true);
      return;
    }

    client.data = { ...client.data, userId, userName };
    client.join(`user:${userId}`);
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data?.userId as string | undefined;
    if (!userId || !this.server) {
      return;
    }

    try {
      const remainingSockets = await this.server
        .in(`user:${userId}`)
        .fetchSockets();
      if (remainingSockets.length === 0) {
        await this.gameService.leaveQueue(userId);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to process disconnect queue cleanup for user ${userId}: ${err}`,
      );
    }
  }

  @SubscribeMessage('joinQueue')
  async handleJoinQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: any,
  ): Promise<OperationResponse> {
    const data = normalizePayload(rawData);
    if (!isObject(data)) {
      return {
        ok: false,
        error: { code: 'invalidPayload', message: 'Payload must be an object' },
      };
    }
    const { userId, userName } = client.data;
    return this.gameService.joinQueue(userId, userName);
  }

  @SubscribeMessage('leaveQueue')
  async handleLeaveQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: any,
  ): Promise<OperationResponse> {
    const data = normalizePayload(rawData);
    if (!isObject(data)) {
      return {
        ok: false,
        error: { code: 'invalidPayload', message: 'Payload must be an object' },
      };
    }
    const { userId } = client.data;
    return this.gameService.leaveQueue(userId);
  }

  @SubscribeMessage('startBotGame')
  async handleStartBotGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: any,
  ): Promise<OperationResponse> {
    const data = normalizePayload(rawData);
    if (!isObject(data)) {
      return {
        ok: false,
        error: { code: 'invalidPayload', message: 'Payload must be an object' },
      };
    }
    const { userId, userName } = client.data;
    return this.gameService.startBotGame(userId, userName);
  }

  @SubscribeMessage('makeMove')
  async handleMakeMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: any,
  ): Promise<OperationResponse> {
    const data = normalizePayload(rawData);
    if (
      !isObject(data) ||
      typeof data.gameId !== 'string' ||
      !UUID_REGEX.test(data.gameId) ||
      typeof data.move !== 'string' ||
      !UCI_MOVE_REGEX.test(data.move)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalidPayload',
          message: 'Valid gameId (UUID) and move (UCI notation) are required.',
        },
      };
    }
    const { userId } = client.data;
    return this.gameService.makeMove(userId, data.gameId, data.move);
  }

  @SubscribeMessage('resign')
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: any,
  ): Promise<OperationResponse> {
    const data = normalizePayload(rawData);
    if (
      !isObject(data) ||
      typeof data.gameId !== 'string' ||
      !UUID_REGEX.test(data.gameId)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalidPayload',
          message: 'Valid gameId (UUID) is required.',
        },
      };
    }
    const { userId } = client.data;
    return this.gameService.resign(userId, data.gameId);
  }

  @SubscribeMessage('getState')
  async handleGetState(
    @ConnectedSocket() client: Socket,
    @MessageBody() rawData: any,
  ): Promise<StateResponse | OperationResponse> {
    const data = normalizePayload(rawData);
    if (!isObject(data)) {
      return {
        ok: false,
        error: { code: 'invalidPayload', message: 'Payload must be an object' },
      };
    }
    const { userId } = client.data;
    return this.gameService.getState(userId);
  }
}
