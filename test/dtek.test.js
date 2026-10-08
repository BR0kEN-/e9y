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
      updated_at: new Date('2026-01-01T10:00:00Z'),
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
      updated_at: new Date('2026-03-28T10:00:00Z'),
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
  assert.equal(status.today.has_outages, true)
  assert.equal(status.tomorrow.has_outages, true)
  assert.match(status.today.hash, /^[a-f0-9]{64}$/)
  assert.match(status.tomorrow.hash, /^[a-f0-9]{64}$/)
  assert.match(status.fingerprint, /^[a-f0-9]{64}$/)
})

test('buildDtekStatus has a stable hash for an empty schedule', () => {
  const data = {
    group: 1.1,
    schedule: {
      updated_at: new Date('2026-01-01T10:00:00Z'),
      events: [],
    },
  }

  const first = buildDtekStatus(data, new Date('2026-01-01T10:00:00Z'))
  const second = buildDtekStatus(data, new Date('2026-01-01T20:00:00Z'))

  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(first.today.has_outages, false)
  assert.equal(first.tomorrow.has_outages, false)
  assert.equal(first.shutdown, null)
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
      updated_at: new Date('2026-01-01T07:00:00Z'),
      events,
    },
  })
  const now = new Date('2026-01-01T07:00:00Z')

  assert.equal(
    buildDtekStatus(data([eventA, eventB]), now).fingerprint,
    buildDtekStatus(data([eventB, eventA]), now).fingerprint,
  )
  assert.deepEqual(
    buildDtekStatus(data([eventB, eventA]), now).events,
    [
      {
        start: '2026-01-01T08:00:00.000Z',
        end: '2026-01-01T10:00:00.000Z',
      },
      {
        start: '2026-01-01T09:00:00.000Z',
        end: '2026-01-01T11:00:00.000Z',
      },
    ],
  )
})

test('buildDtekStatus exposes the next outage and connectivity transitions', () => {
  const data = {
    group: 1.1,
    shutdown: null,
    schedule: {
      updated_at: new Date('2026-01-01T07:00:00Z'),
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
  assert.equal(before.next_outage, '2026-01-01T08:00:00.000Z')
  assert.equal(before.next_connectivity, '2026-01-01T10:00:00.000Z')

  const during = buildDtekStatus(data, new Date('2026-01-01T09:00:00Z'))
  assert.equal(during.next_outage, '2026-01-01T12:00:00.000Z')
  assert.equal(during.next_connectivity, '2026-01-01T10:00:00.000Z')

  const between = buildDtekStatus(data, new Date('2026-01-01T11:00:00Z'))
  assert.equal(between.next_outage, '2026-01-01T12:00:00.000Z')
  assert.equal(between.next_connectivity, '2026-01-01T14:00:00.000Z')

  const after = buildDtekStatus(data, new Date('2026-01-01T15:00:00Z'))
  assert.equal(after.next_outage, null)
  assert.equal(after.next_connectivity, null)
})

test('buildDtekStatus serializes current shutdown details', () => {
  const data = {
    group: 1.1,
    shutdown: {
      updated_at: new Date('2026-01-01T07:00:00Z'),
      started_at: new Date('2026-01-01T08:00:00Z'),
      ends_at: new Date('2026-01-01T10:00:00Z'),
      reason: 'Екстрені відключення',
    },
    schedule: {
      updated_at: new Date('2026-01-01T07:00:00Z'),
      events: [],
    },
  }

  assert.deepEqual(
    buildDtekStatus(data, new Date('2026-01-01T09:00:00Z')).shutdown,
    {
      updated_at: '2026-01-01T07:00:00.000Z',
      started_at: '2026-01-01T08:00:00.000Z',
      ends_at: '2026-01-01T10:00:00.000Z',
      reason: 'Екстрені відключення',
    },
  )
})
