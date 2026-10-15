import { createContext, useContext } from 'react'

export const RemoteControlContext = createContext({
  beforeStopSharing: () => {},
})

export const useRemoteControl = () => useContext(RemoteControlContext)
