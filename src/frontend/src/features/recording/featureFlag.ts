/**
 * Temporary kill switch while the LiveKit Egress worker is scaled to zero.
 * Hiding the entry points avoids users starting a recording that cannot finish.
 * Re-enable only after recording capacity is restored and verified.
 */
export const RECORDING_ENTRY_ENABLED = false
