import { FastifyInstance } from "fastify";
import { createRedisSubscriber } from "../../cache/redis.js";
import { LiveService, liveMatchChannel, liveMatchUpdatesChannel } from "./live.service.js";

export async function liveWebsocketRoutes(app: FastifyInstance) {
  const service = new LiveService();

  app.get<{ Params: { id: string } }>("/ws/matches/:id", { websocket: true }, async (socket, request) => {
    const matchId = request.params.id;
    const subscriber = createRedisSubscriber();
    const channels = [liveMatchUpdatesChannel(matchId), liveMatchChannel(matchId)];

    const current = await service.get(matchId);
    if (current) {
      socket.send(JSON.stringify({ type: "snapshot", data: current }));
    }

    await subscriber.subscribe(...channels);
    subscriber.on("message", (_channel: string, message: string) => {
      socket.send(JSON.stringify({ type: "update", data: JSON.parse(message) }));
    });

    socket.on("close", async () => {
      await subscriber.unsubscribe(...channels);
      subscriber.disconnect();
    });
  });
}
