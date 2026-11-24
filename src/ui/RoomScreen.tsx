import { EventScreen } from "./room-screen/EventScreen.tsx";
import { MerchantScreen } from "./room-screen/MerchantScreen.tsx";
import { RelicRoomScreen } from "./room-screen/RelicRoomScreen.tsx";
import type { RoomScreenProps } from "./room-screen/shared.ts";

export function RoomScreen(props: RoomScreenProps) {
  if (props.room.kind === "merchant")
    return <MerchantScreen {...props} room={props.room} />;
  if (props.room.kind === "event")
    return <EventScreen {...props} room={props.room} />;
  return <RelicRoomScreen {...props} room={props.room} />;
}
