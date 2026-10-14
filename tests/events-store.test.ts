import { describe, expect, it, mock } from 'bun:test'
import { openDatabase } from '../src/db'
import { createEventBus } from '../src/events/bus'
import { appendEvent, headCursor, isCursorExpired, listEvents, prunedThrough, pruneEvents } from '../src/events/store'

function setup() {
  const db = openDatabase(':memory:')
  // Event recipients have no FK to devices, so plain IDs suffice here.
  return db
}

const low = (available: number) => ({ type: 'keypackages.low' as const, data: { available } })

describe('event store', () => {
  it('appends and lists events in cursor order, filtered per device', () => {
    const db = setup()
    const e1 = appendEvent(db, { ...low(1), deviceIds: ['d_a', 'd_b'], now: 10 })!
    const e2 = appendEvent(db, { ...low(2), deviceIds: ['d_b'], now: 11 })!
    const e3 = appendEvent(db, { ...low(3), deviceIds: ['d_a', 'd_a'], now: 12 })!

    expect(e1).toEqual({ cursor: 1, type: 'keypackages.low', created_at: 10, data: { available: 1 } })
    expect([e2.cursor, e3.cursor]).toEqual([2, 3])

    expect(listEvents(db, 'd_a', 0, 100).map(e => e.cursor)).toEqual([1, 3])
    expect(listEvents(db, 'd_b', 0, 100).map(e => e.cursor)).toEqual([1, 2])
    expect(listEvents(db, 'd_a', 1, 100)).toEqual([e3])
    expect(listEvents(db, 'd_b', 0, 1)).toEqual([e1])
    expect(listEvents(db, 'd_c', 0, 100)).toEqual([])
    expect(headCursor(db)).toBe(3)
  })

  it('is a no-op for an empty recipient set', () => {
    const db = setup()
    expect(appendEvent(db, { ...low(0), deviceIds: [], now: 1 })).toBeNull()
    expect(headCursor(db)).toBe(0)
    expect(db.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 })
  })

  it('rolls back with the enclosing transaction', () => {
    const db = setup()
    expect(() => db.transaction(() => {
      appendEvent(db, { ...low(0), deviceIds: ['d_a'], now: 1 })
      throw new Error('boom')
    })()).toThrow('boom')
    expect(listEvents(db, 'd_a', 0, 100)).toEqual([])
  })

  it('prunes old events and tracks the pruned cursor', () => {
    const db = setup()
    appendEvent(db, { ...low(1), deviceIds: ['d_a'], now: 100 })
    appendEvent(db, { ...low(2), deviceIds: ['d_a', 'd_b'], now: 200 })
    appendEvent(db, { ...low(3), deviceIds: ['d_a'], now: 300 })

    expect(prunedThrough(db)).toBe(0)
    expect(isCursorExpired(db, 0)).toBe(false)

    expect(pruneEvents(db, 250)).toBe(2)
    expect(prunedThrough(db)).toBe(2)
    expect(listEvents(db, 'd_a', 0, 100).map(e => e.cursor)).toEqual([3])
    expect(db.query('SELECT count(*) AS n FROM event_recipients').get()).toEqual({ n: 1 })
    expect(isCursorExpired(db, 0)).toBe(true)
    expect(isCursorExpired(db, 1)).toBe(true)
    expect(isCursorExpired(db, 2)).toBe(false)
    expect(isCursorExpired(db, 3)).toBe(false)

    // Nothing older: pruned-through stays put.
    expect(pruneEvents(db, 250)).toBe(0)
    expect(prunedThrough(db)).toBe(2)

    // Pruning everything never moves the head cursor backwards.
    expect(pruneEvents(db, 1000)).toBe(1)
    expect(prunedThrough(db)).toBe(3)
    expect(headCursor(db)).toBe(3)
    expect(appendEvent(db, { ...low(4), deviceIds: ['d_a'], now: 1001 })!.cursor).toBe(4)
  })
})

describe('event bus', () => {
  it('notifies subscribers of published devices only', () => {
    const bus = createEventBus()
    const a = mock(() => {})
    const b = mock(() => {})
    const unsubA = bus.subscribe('d_a', a)
    bus.subscribe('d_b', b)

    bus.publish(['d_a', 'd_a', 'd_c'])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(0)

    unsubA()
    bus.publish(['d_a', 'd_b'])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('supports several listeners per device', () => {
    const bus = createEventBus()
    const l1 = mock(() => {})
    const l2 = mock(() => {})
    bus.subscribe('d_a', l1)
    const unsub2 = bus.subscribe('d_a', l2)
    unsub2()
    bus.publish(['d_a'])
    expect(l1).toHaveBeenCalledTimes(1)
    expect(l2).toHaveBeenCalledTimes(0)
  })
})
