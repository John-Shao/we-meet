export const shouldCollapseRailInitially = (
  storedPreference: string | null,
  compactViewport: boolean
) => compactViewport || storedPreference === '1'
