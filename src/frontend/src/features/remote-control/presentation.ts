/** Only these user-facing categories are rendered; never display raw errors. */
export function endReasonKey(reason?: string) {
  switch (reason) {
    case 'remote_rejected':
    case 'consent_denied':
      return 'declined'
    case 'remote_cancelled':
      return 'cancelled'
    case 'local_stop':
    case 'remote_ended':
    case 'emergency_stop':
      return 'stopped'
    case 'authorization_expired':
    case 'lease_expired':
    case 'remote_expired':
    case 'consent_expired':
    case 'challenge_expired':
      return 'expired'
    case 'connection_changed':
    case 'controller_context_changed':
    case 'participant_left':
    case 'meeting_left':
    case 'target_timeout':
    case 'controller_timeout':
      return 'connection'
    case 'screen_share_unavailable':
    case 'share_stopped':
    case 'capture_changed':
    case 'display_changed':
      return 'screen'
    case 'input_ack_timeout':
    case 'native_ack_timeout':
      return 'unconfirmed'
    case 'desktop_locked':
    case 'system_suspend':
    case 'session_changed':
      return 'device'
    default:
      return 'generic'
  }
}
