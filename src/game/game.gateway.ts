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

@WebSocketGateway({
  // The API gateway routes this path here and requires a valid token on it.
  path: '/ws/game',
  // Without long polling a connection needs no sticky session between the instances.
  transports: ['websocket'],
})
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly gameService: GameService) {}

  afterInit(server: Server) {
    this.gameService.setServer(server);
  }

  handleConnection(client: Socket) {
    const headers = client.handshake.headers;
    const userId = headers['x-user-id'] as string | undefined;
    const userName = headers['x-user-name'] as string | undefined;

    if (!userId || !userName) {
      // Disconnect if identity headers from Envoy gateway are missing
      client.disconnect(true);
      return;
    }

    client.data = { userId, userName };
    client.join(`user:${userId}`);
  }

  handleDisconnect(client: Socket) {
    // Disconnection is stateless according to ADR-10
  }

  @SubscribeMessage('joinQueue')
  async handleJoinQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ): Promise<OperationResponse> {
    if (data && typeof data !== 'object') {
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
    @MessageBody() data: any,
  ): Promise<OperationResponse> {
    if (data && typeof data !== 'object') {
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
    @MessageBody() data: any,
  ): Promise<OperationResponse> {
    if (data && typeof data !== 'object') {
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
    @MessageBody() data: any,
  ): Promise<OperationResponse> {
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.gameId !== 'string' ||
      typeof data.move !== 'string'
    ) {
      return {
        ok: false,
        error: {
          code: 'invalidPayload',
          message: 'gameId and move strings are required.',
        },
      };
    }
    const { userId } = client.data;
    return this.gameService.makeMove(userId, data.gameId, data.move);
  }

  @SubscribeMessage('resign')
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ): Promise<OperationResponse> {
    if (!data || typeof data !== 'object' || typeof data.gameId !== 'string') {
      return {
        ok: false,
        error: { code: 'invalidPayload', message: 'gameId string is required.' },
      };
    }
    const { userId } = client.data;
    return this.gameService.resign(userId, data.gameId);
  }

  @SubscribeMessage('getState')
  async handleGetState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ): Promise<StateResponse | OperationResponse> {
    if (data && typeof data !== 'object') {
      return {
        ok: false,
        error: { code: 'invalidPayload', message: 'Payload must be an object' },
      };
    }
    const { userId } = client.data;
    return this.gameService.getState(userId);
  }
}
