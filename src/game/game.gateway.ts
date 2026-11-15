import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';

@WebSocketGateway({
  // The API gateway routes this path here and requires a valid token on it.
  path: '/ws/game',
  // Without long polling a connection needs no sticky session between the instances.
  transports: ['websocket'],
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly gameService: GameService) {}

  handleConnection(client: Socket) {
    console.log(`[WebSocket] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[WebSocket] Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join_queue')
  handleJoinQueue(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    // TODO: Add player to matchmaking queue
    client.emit('queue_status', { message: 'Matchmaking is not yet implemented' });
  }

  @SubscribeMessage('make_move')
  handleMakeMove(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    // TODO: Validate and broadcast move
    client.emit('error', { message: 'Move processing is not yet implemented' });
  }
}
