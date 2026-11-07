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
  cors: { origin: '*' },
  path: '/socket.io',
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
