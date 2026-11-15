import { WebSocketGateway, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@WebSocketGateway({
  // The API gateway routes this path here without asking for a token, so guests can watch too.
  path: '/ws/spectate',
  // Without long polling a connection needs no sticky session between the instances.
  transports: ['websocket'],
})
export class SpectateGateway implements OnGatewayConnection, OnGatewayDisconnect {
  handleConnection(client: Socket) {
    // TODO: Check the token of the spectator link
    console.log(`[WebSocket] Spectator connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[WebSocket] Spectator disconnected: ${client.id}`);
  }
}
