export type CalmScene = 'baton' | 'metronome' | 'swell'

/** The context window as the bar draws it: what fills it, and where it compacts. */
export type CalmContext = {
  used: number
  window: number
  compactAt: number | null
  parts: { kind: 'used' | 'free' | 'buffer'; tokens: number; color: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    calm: {
      enabled: boolean
      scene: CalmScene
      tick: number
      context: CalmContext | null
    }
  }
}
