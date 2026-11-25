import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';

@WebSocketGateway({
  // The API gateway routes this path here without asking for a token, so guests can watch too.
  path: '/ws/spectate',
  // Without long polling a connection needs no sticky session between the instances.
  transports: ['websocket'],
})
export class SpectateGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  handleConnection(client: Socket) {
    // Spectator connected
  }

  handleDisconnect(client: Socket) {
    // Spectator disconnected
  }

  @SubscribeMessage('spectateGame')
  handleSpectateGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ) {
    if (data && typeof data.gameId === 'string') {
      client.join(`game:${data.gameId}`);
      return { ok: true };
    }
    return { ok: false };
  }
}
