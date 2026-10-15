/** Serializable renderer contract. No native handles, coordinates or signing keys. */
export type RemoteRoomReference = { roomId: string; roomSid: string; participantSid: string };
export type RemoteCaptureReference = { shareInstanceId: string; width: number; height: number; trackSid?: string };
export type RemoteTargetStatus = {
  phase: string; sessionId?: string; epoch?: number; stateVersion?: number;
  inputOpen: boolean; cleanupBlocked: boolean; reason?: string;
};
export type RemoteCapabilities = {
  enabled: boolean; contextId?: string; canBeControlled: boolean;
  capture?: RemoteCaptureReference; status: RemoteTargetStatus;
};
export type RemoteDesktopEvent =
  | { type: "state"; contextId?: string; status: RemoteTargetStatus; capture?: RemoteCaptureReference }
  | { type: "send"; contextId: string; messageId: string; topic: string; destinationIdentity: string; payload: Uint8Array };
export type RemoteRelayMessage =
  | { contextId: string; kind: "received"; topic: string; participantIdentity: string; participantSid: string; payload: Uint8Array }
  | { contextId: string; kind: "sent"; messageId: string; ok: boolean };
export type RemoteStopReason = "local_stop" | "share_stopped" | "meeting_left" | "connection_changed" | "video_unavailable";
export interface RemoteControlBridge {
  capabilities(room: RemoteRoomReference): Promise<RemoteCapabilities>;
  showRequest(request: { contextId: string; sessionId: string }): Promise<{ needsScreen: boolean }>;
  bindPublishedTrack(binding: { contextId: string; shareInstanceId: string; trackSid: string }): Promise<void>;
  forwardSignedMessage(message: RemoteRelayMessage): Promise<void>;
  stop(request: { contextId: string; reason: RemoteStopReason }): Promise<void>;
  onState(listener: (event: RemoteDesktopEvent) => void): () => void;
}
