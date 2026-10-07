import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDtekStatus,
  buildIcs,
  buildIntervals,
  optionIndex,
} from '../src/dtek.js'

test('selects the exact locality instead of the first partial autocomplete match', () => {
  const options = [
    'с-ще дніпровське',
    'смт дніпровське',
    'м. дніпро',
    'м. верхньодніпровськ',
  ]

  assert.equal(optionIndex(options, 'Дніпро'), 2)
  assert.equal(optionIndex(['Шосе Запорізьке'], 'шосе Запорізьке'), 0)
})

test('buildIntervals merges adjacent full and half-hour outages', () => {
  const intervals = buildIntervals([{
    timestamp: new Date('2026-01-01T00:00:00+02:00').getTime() / 1000,
    hours: { 1: 'second', 2: 'no', 3: 'first' },
  }])

  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].start.toISOString(), '2025-12-31T22:30:00.000Z')
  assert.equal(intervals[0].end.toISOString(), '2026-01-01T00:30:00.000Z')
})

test('calendar event UIDs remain stable across refreshes', () => {
  const address = {
    region: 'dnem',
    locality: 'Дніпро',
    street: 'Шосе',
    building: '80',
  }
  const data = {
    group: 1.1,
    shutdown: null,
    schedule: {
      updatedAt: new Date('2026-01-01T10:00:00Z'),
      events: [{
        start: new Date('2026-01-01T18:00:00Z'),
        end: new Date('2026-01-01T20:00:00Z'),
      }],
    },
  }

  assert.equal(buildIcs(address, data), buildIcs(address, data))
  assert.match(buildIcs(address, data), /BEGIN:VCALENDAR/)
})

test('buildDtekStatus hashes today and tomorrow independently', () => {
  const data = {
    group: 1.1,
    shutdown: null,
    schedule: {
      updatedAt: new Date('2026-03-28T10:00:00Z'),
      events: [
        {
          start: new Date('2026-03-28T22:30:00Z'),
          end: new Date('2026-03-29T01:30:00Z'),
        },
        {
          start: new Date('2026-03-29T21:00:00Z'),
          end: new Date('2026-03-29T22:00:00Z'),
        },
      ],
    },
  }
  const status = buildDtekStatus(data, new Date('2026-03-28T22:15:00Z'))

  assert.equal(status.today.date, '2026-03-29')
  assert.equal(status.tomorrow.date, '2026-03-30')
  assert.equal(status.today.hasOutages, true)
  assert.equal(status.tomorrow.hasOutages, true)
  assert.match(status.today.hash, /^[a-f0-9]{64}$/)
  assert.match(status.tomorrow.hash, /^[a-f0-9]{64}$/)
  assert.match(status.fingerprint, /^[a-f0-9]{64}$/)
})

test('buildDtekStatus has a stable hash for an empty schedule', () => {
  const data = {
    group: 1.1,
    schedule: {
      updatedAt: new Date('2026-01-01T10:00:00Z'),
      events: [],
    },
  }

  const first = buildDtekStatus(data, new Date('2026-01-01T10:00:00Z'))
  const second = buildDtekStatus(data, new Date('2026-01-01T20:00:00Z'))

  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(first.today.hasOutages, false)
  assert.equal(first.tomorrow.hasOutages, false)
  assert.deepEqual(first.shutdown, {})
})

test('buildDtekStatus canonicalizes reordered and overlapping events', () => {
  const eventA = {
    start: new Date('2026-01-01T08:00:00Z'),
    end: new Date('2026-01-01T10:00:00Z'),
  }
  const eventB = {
    start: new Date('2026-01-01T09:00:00Z'),
    end: new Date('2026-01-01T11:00:00Z'),
  }
  const data = (events) => ({
    group: 1.1,
    shutdown: null,
    schedule: {
      updatedAt: new Date('2026-01-01T07:00:00Z'),
      events,
    },
  })
  const now = new Date('2026-01-01T07:00:00Z')

  assert.equal(
    buildDtekStatus(data([eventA, eventB]), now).fingerprint,
    buildDtekStatus(data([eventB, eventA]), now).fingerprint,
  )
})

test('buildDtekStatus exposes the next outage and connectivity transitions', () => {
  const data = {
    group: 1.1,
    shutdown: null,
    schedule: {
      updatedAt: new Date('2026-01-01T07:00:00Z'),
      events: [
        {
          start: new Date('2026-01-01T08:00:00Z'),
          end: new Date('2026-01-01T10:00:00Z'),
        },
        {
          start: new Date('2026-01-01T12:00:00Z'),
          end: new Date('2026-01-01T14:00:00Z'),
        },
      ],
    },
  }

  const before = buildDtekStatus(data, new Date('2026-01-01T07:00:00Z'))
  assert.equal(before.nextOutage, '2026-01-01T08:00:00.000Z')
  assert.equal(before.nextConnectivity, '2026-01-01T10:00:00.000Z')

  const during = buildDtekStatus(data, new Date('2026-01-01T09:00:00Z'))
  assert.equal(during.nextOutage, '2026-01-01T12:00:00.000Z')
  assert.equal(during.nextConnectivity, '2026-01-01T10:00:00.000Z')

  const between = buildDtekStatus(data, new Date('2026-01-01T11:00:00Z'))
  assert.equal(between.nextOutage, '2026-01-01T12:00:00.000Z')
  assert.equal(between.nextConnectivity, '2026-01-01T14:00:00.000Z')

  const after = buildDtekStatus(data, new Date('2026-01-01T15:00:00Z'))
  assert.equal(after.nextOutage, null)
  assert.equal(after.nextConnectivity, null)
})

test('buildDtekStatus serializes current shutdown details', () => {
  const data = {
    group: 1.1,
    shutdown: {
      updatedAt: new Date('2026-01-01T07:00:00Z'),
      startedAt: new Date('2026-01-01T08:00:00Z'),
      endsAt: new Date('2026-01-01T10:00:00Z'),
      reason: 'Екстрені відключення',
    },
    schedule: {
      updatedAt: new Date('2026-01-01T07:00:00Z'),
      events: [],
    },
  }

  assert.deepEqual(
    buildDtekStatus(data, new Date('2026-01-01T09:00:00Z')).shutdown,
    {
      updatedAt: '2026-01-01T07:00:00.000Z',
      startedAt: '2026-01-01T08:00:00.000Z',
      endsAt: '2026-01-01T10:00:00.000Z',
      reason: 'Екстрені відключення',
    },
  )
})
