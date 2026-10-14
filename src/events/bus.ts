type Listener = () => void

/**
 * In-process notifier. It carries no event data: listeners are woken up and
 * read new events from the store with `listEvents`. Publish only after the
 * transaction that appended the events has committed.
 */
export interface EventBus {
  subscribe: (deviceId: string, listener: Listener) => () => void
  publish: (deviceIds: Iterable<string>) => void
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<Listener>>()

  return {
    subscribe(deviceId, listener) {
      let set = listeners.get(deviceId)
      if (!set) {
        set = new Set()
        listeners.set(deviceId, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0 && listeners.get(deviceId) === set)
          listeners.delete(deviceId)
      }
    },
    publish(deviceIds) {
      for (const deviceId of new Set(deviceIds)) {
        for (const listener of [...(listeners.get(deviceId) ?? [])])
          listener()
      }
    },
  }
}
