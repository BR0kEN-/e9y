import { createHash } from 'node:crypto'

const BLOCKED_RESOURCE_TYPES = new Set(['stylesheet', 'image', 'media', 'font', 'other'])
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const FINGERPRINT_VERSION = 1
const FINGERPRINT_DATE = /^\d{4}-\d{2}-\d{2}$/
const FINGERPRINT_HASH = /^[a-f0-9]{64}$/
const preparedDtekPages = new WeakMap()

function formatDate(input) {
  const [date, time] = input.toLocaleString(process.env.LOCALE, { timeZone: process.env.TZ }).split(', ')
  const [day, month, year] = date.split('.')
  return `${year}-${month}-${day} ${time}`
}

function formatDateIcs(input) {
  return formatDate(input).replace(' ', 'T').replace(/[-:]/g, '')
}

export function toDatetime(date, time) {
  if (time === undefined && date.includes(' ')) {
    const [first, second] = date.split(' ');
    [date, time] = first.includes(':') ? [second, first] : [first, second]
  }

  const [day, month, year] = date.split('.')
  return new Date(`${year}-${month}-${day}T${time}`)
}

export function buildIntervals(days) {
  const intervals = []

  for (const { timestamp, hours } of [...days].sort((left, right) => left.timestamp - right.timestamp)) {
    const dayStart = new Date(timestamp * 1000)
    dayStart.setHours(0, 0, 0, 0)

    for (let hour = 1; hour <= 24; hour += 1) {
      const startMinute = (hour - 1) * 60
      const endMinute = hour * 60
      const half = startMinute + 30
      let segment

      if (hours[hour] === 'no') {
        segment = { startMinute, endMinute }
      } else if (hours[hour] === 'first') {
        segment = { startMinute, endMinute: half }
      } else if (hours[hour] === 'second') {
        segment = { startMinute: half, endMinute }
      } else {
        continue
      }

      const start = new Date(dayStart)
      start.setMinutes(start.getMinutes() + segment.startMinute)
      const end = new Date(dayStart)
      end.setMinutes(end.getMinutes() + segment.endMinute)
      const previous = intervals.at(-1)

      if (previous && previous.end.getTime() === start.getTime()) {
        previous.end = end
      } else {
        intervals.push({ start, end })
      }
    }
  }

  return intervals
}

function localDate(input) {
  const parts = Object.fromEntries(
    DATE_FORMATTER.formatToParts(input)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  )

  return `${parts.year}-${parts.month}-${parts.day}`
}

function addCalendarDays(date, days) {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + days)
  return localDate(value)
}

function scheduleDay(date, events) {
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(`${addCalendarDays(date, 1)}T00:00:00`)
  const ranges = events
    .filter((event) => event.start < end && event.end > start)
    .map((event) => [
      Math.max(event.start.getTime(), start.getTime()),
      Math.min(event.end.getTime(), end.getTime()),
    ])
    .sort(([left], [right]) => left - right)
  const canonical = []

  for (const [rangeStart, rangeEnd] of ranges) {
    const previous = canonical.at(-1)

    if (previous && rangeStart <= previous[1]) {
      previous[1] = Math.max(previous[1], rangeEnd)
    } else {
      canonical.push([rangeStart, rangeEnd])
    }
  }

  const intervals = canonical.map(([rangeStart, rangeEnd]) => [
    new Date(rangeStart).toISOString(),
    new Date(rangeEnd).toISOString(),
  ])
  const hash = createHash('sha256').update(JSON.stringify(intervals)).digest('hex')

  return { date, hash, has_outages: intervals.length > 0 }
}

function nextTransitions(events, now) {
  const timestamp = now.getTime()
  const ordered = [...events].sort((left, right) => left.start - right.start)
  const outage = ordered.find((event) => event.start.getTime() > timestamp)
  const connectivity = ordered.find((event) => event.end.getTime() > timestamp)

  return {
    next_outage: outage?.start.toISOString() ?? null,
    next_connectivity: connectivity?.end.toISOString() ?? null,
  }
}

function serializeShutdown(shutdown) {
  return shutdown
    ? {
        updated_at: shutdown.updated_at.toISOString(),
        started_at: shutdown.started_at.toISOString(),
        ends_at: shutdown.ends_at.toISOString(),
        reason: shutdown.reason,
      }
    : null
}

function serializeEvents(events) {
  return [...events]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((event) => ({
      start: event.start.toISOString(),
      end: event.end.toISOString(),
    }))
}

export function encodeDtekFingerprint(days) {
  const payload = [
    FINGERPRINT_VERSION,
    days.map(({ date, hash, has_outages: hasOutages }) => [
      date,
      hash,
      hasOutages ? 1 : 0,
    ]),
  ]

  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeDtekFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 255) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(fingerprint, 'base64url').toString())

    if (
      !Array.isArray(payload)
      || payload.length !== 2
      || payload[0] !== FINGERPRINT_VERSION
      || !Array.isArray(payload[1])
      || payload[1].length !== 2
    ) {
      return null
    }

    const days = payload[1].map((day) => {
      if (
        !Array.isArray(day)
        || day.length !== 3
        || typeof day[0] !== 'string'
        || !FINGERPRINT_DATE.test(day[0])
        || typeof day[1] !== 'string'
        || !FINGERPRINT_HASH.test(day[1])
        || (day[2] !== 0 && day[2] !== 1)
      ) {
        throw new TypeError('Invalid DTEK fingerprint')
      }

      return {
        date: day[0],
        hash: day[1],
        has_outages: day[2] === 1,
      }
    })

    return new Set(days.map(({ date }) => date)).size === days.length ? days : null
  } catch {
    return null
  }
}

function compareDtekFingerprint(days, previousFingerprint) {
  const previousDays = decodeDtekFingerprint(previousFingerprint)

  if (!previousDays) {
    return {
      schedule_changed: false,
      tomorrow_became_available: false,
    }
  }

  const previousByDate = new Map(previousDays.map((day) => [day.date, day]))
  const scheduleChanged = days.some((day) => {
    const previous = previousByDate.get(day.date)
    return previous ? previous.hash !== day.hash : day.has_outages
  })
  const tomorrow = days[1]
  const previousTomorrow = previousByDate.get(tomorrow.date)

  return {
    schedule_changed: scheduleChanged,
    tomorrow_became_available: tomorrow.has_outages
      && (!previousTomorrow || !previousTomorrow.has_outages),
  }
}

export function buildDtekStatus(data, now = new Date(), previousFingerprint = null) {
  const todayDate = localDate(now)
  const today = scheduleDay(todayDate, data.schedule.events)
  const tomorrow = scheduleDay(addCalendarDays(todayDate, 1), data.schedule.events)
  const days = [today, tomorrow]
  const transitions = nextTransitions(data.schedule.events, now)
  const fingerprint = encodeDtekFingerprint(days)

  return {
    fingerprint,
    ...compareDtekFingerprint(days, previousFingerprint),
    group: data.group,
    updated_at: data.schedule.updated_at.toISOString(),
    checked_at: now.toISOString(),
    events: serializeEvents(data.schedule.events),
    ...transitions,
    today,
    tomorrow,
    shutdown: serializeShutdown(data.shutdown),
  }
}

export function optionIndex(options, requested) {
  const normalize = (value) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase(process.env.LOCALE)
  const target = normalize(requested)
  const values = options.map(normalize)
  const exact = values.indexOf(target)

  if (exact >= 0) {
    return exact
  }

  const suffix = values.findIndex((value) => value.endsWith(` ${target}`))
  return suffix >= 0 ? suffix : 0
}

async function prepareDtekPage(page, address) {
  const domain = `dtek-${address.region}.com.ua`
  const baseUrl = `https://www.${domain}`

  if (preparedDtekPages.get(page) === address.region) {
    return
  }

  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const action = BLOCKED_RESOURCE_TYPES.has(request.resourceType()) || !request.url().startsWith(baseUrl)
      ? request.abort('blockedbyclient')
      : request.continue()
    action.catch(() => {})
  })

  await page.goto(`${baseUrl}/ua/shutdowns`, { waitUntil: 'domcontentloaded' })
  // Handle `Сайт працює, але через велике навантаження треба трохи зачекати і сторінка завантажиться.`.
  await page.waitForFunction(() => (
    typeof DisconSchedule !== 'undefined'
      && Boolean(DisconSchedule.fact)
      && Boolean(DisconSchedule.preset)
      && Boolean(DisconSchedule.streets)
      && Boolean(document.querySelector('#discon_form'))
  ), { timeout: 120_000 })

  preparedDtekPages.set(page, address.region)
}

async function queryDtekAddress(page, address, timeout) {
  return page.evaluate(async ({ requested, requestTimeout }) => {
    const normalize = (value) => String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
    const select = (options, value, type) => {
      const target = normalize(value)
      const normalized = options.map(normalize)
      let index = normalized.indexOf(target)

      if (index < 0) index = normalized.findIndex((option) => option.endsWith(` ${target}`))
      if (index < 0) index = normalized.findIndex((option) => option.includes(target))
      if (index < 0) throw new Error(`DTEK ${type} not found: ${value}`)
      return options[index]
    }

    const streetsByLocality = DisconSchedule.streets
    let locality = requested.locality
    let streets

    if (Array.isArray(streetsByLocality)) {
      streets = streetsByLocality
    } else {
      locality = select(Object.keys(streetsByLocality), requested.locality, 'locality')
      streets = streetsByLocality[locality]
    }

    const street = select(streets, requested.street, 'street')
    const fields = []
    if (document.querySelector('#discon_form [name="city"]')) {
      fields.push({ name: 'city', value: locality })
    }
    fields.push({ name: 'street', value: street })
    if (DisconSchedule.fact?.update) {
      fields.push({ name: 'updateFact', value: DisconSchedule.fact.update })
    }

    const body = new URLSearchParams({ method: 'getHomeNum' })
    fields.forEach(({ name, value }, index) => {
      body.set(`data[${index}][name]`, name)
      body.set(`data[${index}][value]`, value)
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeout)
    let answer

    try {
      const response = await fetch(document.querySelector('meta[name="ajaxUrl"]').content, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(`DTEK returned HTTP ${response.status}`)
      answer = await response.json()
    } finally {
      clearTimeout(timer)
    }

    if (!answer?.result || !answer.data) {
      throw new Error('DTEK address lookup failed')
    }

    if (answer.fact) {
      DisconSchedule.fact = answer.fact
      DisconSchedule.preset = answer.preset
      const update = document.querySelector('#discon_form [name="updateFact"]')
      if (update) update.value = answer.fact.update
    }

    return {
      data: answer.data,
      updateTimestamp: answer.updateTimestamp,
      schedule: {
        updated_at: DisconSchedule.fact.update,
        days: Object.entries(DisconSchedule.fact.data).map(([timestamp, groups]) => ({
          timestamp: Number(timestamp),
          groups,
        })),
      },
    }
  }, { requested: address, requestTimeout: timeout })
}

function addressDetails(response, address) {
  const entries = Object.entries(response.data)
  const data = response.data[address.building] || (entries.length === 1 ? entries[0][1] : null)

  if (!data) {
    throw new Error(`DTEK building not found: ${address.building}`)
  }

  const groups = Array.isArray(data.sub_type_reason)
    ? data.sub_type_reason
    : [data.sub_type_reason]
  const groupKey = groups.find(Boolean)

  if (!groupKey) {
    throw new Error(`DTEK group not found for building: ${address.building}`)
  }

  const group = Number.parseFloat(String(groupKey).replace(/^[^\d]+/, ''))

  if (!Number.isFinite(group)) {
    throw new Error(`Invalid DTEK group: ${groupKey}`)
  }

  return { data, group, groupKey }
}

export async function collectDtek(page, address, timeout) {
  await prepareDtekPage(page, address)
  const response = await queryDtekAddress(page, address, timeout)
  const { data, group, groupKey } = addressDetails(response, address)
  const days = response.schedule.days.map(({ timestamp, groups }) => ({
    timestamp,
    hours: groups[groupKey] || {},
  }))

  return {
    group,
    shutdown: !data?.type
      ? null
      : {
          updated_at: toDatetime(response.updateTimestamp),
          started_at: toDatetime(data.start_date),
          ends_at: toDatetime(data.end_date),
          reason: Number(data.type) === 1 ? 'Планові ремонтні роботи' : data.sub_type || 'Unknown',
        },
    schedule: {
      updated_at: toDatetime(response.schedule.updated_at),
      events: buildIntervals(days),
    },
  }
}

function escapeIcs(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\n', '\\n')
}

export function buildIcs(address, data) {
  const location = `${address.locality}, ${address.street} ${address.building}`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//DTEK ${address.region.toUpperCase()} Outages ${data.group}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]

  for (const event of data.schedule.events) {
    const uid = createHash('sha256')
      .update(`${location}|${event.start.toISOString()}|${event.end.toISOString()}`)
      .digest('hex')

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}@e9y-api`,
      `DTSTAMP:${formatDateIcs(data.schedule.updated_at)}Z`,
      `DTSTART;TZID=Europe/Kyiv:${formatDateIcs(event.start)}`,
      `DTEND;TZID=Europe/Kyiv:${formatDateIcs(event.end)}`,
      `SUMMARY:${escapeIcs(`Power outage (group ${data.group})`)}`,
      `LOCATION:${escapeIcs(location)}`,
      `DESCRIPTION:${escapeIcs(`Updated at ${formatDate(data.schedule.updated_at)}`)}`,
      'END:VEVENT',
    )
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}
