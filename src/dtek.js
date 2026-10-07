import { createHash } from 'node:crypto'

const BLOCKED_RESOURCE_TYPES = new Set(['stylesheet', 'image', 'media', 'font', 'other'])
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

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
        updated_at: shutdown.updatedAt.toISOString(),
        started_at: shutdown.startedAt.toISOString(),
        ends_at: shutdown.endsAt.toISOString(),
        reason: shutdown.reason,
      }
    : null
}

export function buildDtekStatus(data, now = new Date()) {
  const todayDate = localDate(now)
  const today = scheduleDay(todayDate, data.schedule.events)
  const tomorrow = scheduleDay(addCalendarDays(todayDate, 1), data.schedule.events)
  const transitions = nextTransitions(data.schedule.events, now)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([today, tomorrow]))
    .digest('hex')

  return {
    fingerprint,
    group: data.group,
    updated_at: data.schedule.updatedAt.toISOString(),
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

async function fillAutocomplete(page, name, value) {
  const input = `input[name="${name}"]`
  const selector = `${input} ~ .autocomplete-items > div`

  await new Promise((resolve) => setTimeout(resolve, 50))
  await page.locator(input).setWaitForEnabled(true).fill(value)
  await page.waitForSelector(selector)

  const text = await page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent || ''))
  const options = await page.$$(selector)
  await options[optionIndex(text, value)].click()
  await page.waitForSelector(selector, { hidden: true })
}

function waitForDetails(page, timeout) {
  let timer
  let handler

  const cancel = () => {
    clearTimeout(timer)
    page.off('response', handler)
  }

  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      cancel()
      reject(new Error('Timed out waiting for DTEK details'))
    }, timeout)

    handler = async (response) => {
      if (!response.url().endsWith('/ua/ajax')) {
        return
      }

      try {
        const data = await response.json()

        if (data?.data && data.updateTimestamp !== undefined) {
          cancel()
          resolve(data)
        }
      } catch {
        // Not the final address-details response.
      }
    }

    page.on('response', handler)
  })

  return { promise, cancel }
}

export async function collectDtek(page, context, address, cookies, timeout) {
  const domain = `dtek-${address.region}.com.ua`
  const baseUrl = `https://www.${domain}`

  if (cookies.length) {
    await context.setCookie(...cookies.map(({ name, value }) => ({
      name,
      value,
      domain: `.${domain}`,
      secure: true,
      httpOnly: true,
      sameSite: 'None',
    })))
  }

  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const action = BLOCKED_RESOURCE_TYPES.has(request.resourceType()) || !request.url().startsWith(baseUrl)
      ? request.abort('blockedbyclient')
      : request.continue()
    action.catch(() => {})
  })

  await page.goto(`${baseUrl}/ua/shutdowns`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(document.querySelector('.wrapper')), { timeout })

  if (address.region !== 'kem') {
    await fillAutocomplete(page, 'city', address.locality)
  }
  await fillAutocomplete(page, 'street', address.street)

  const details = waitForDetails(page, timeout)
  let response

  try {
    [response] = await Promise.all([
      details.promise,
      fillAutocomplete(page, 'house_num', address.building),
    ])
  } finally {
    details.cancel()
  }

  const data = response.data[address.building] || Object.values(response.data)[0]
  const extracted = await page.evaluate(() => ({
    group: DisconSchedule.group,
    updatedAt: DisconSchedule.fact.update,
    days: Object.entries(DisconSchedule.fact.data).map(([timestamp, groups]) => ({
      timestamp: Number(timestamp),
      hours: groups[DisconSchedule.group],
    })),
  }))

  return {
    group: Number.parseFloat(String(extracted.group).replace(/[^\d.]+/, '')),
    shutdown: !data?.type
      ? null
      : {
          updatedAt: toDatetime(response.updateTimestamp),
          startedAt: toDatetime(data.start_date),
          endsAt: toDatetime(data.end_date),
          reason: Number(data.type) === 1 ? 'Планові ремонтні роботи' : data.sub_type || 'Unknown',
        },
    schedule: {
      updatedAt: toDatetime(extracted.updatedAt),
      events: buildIntervals(extracted.days),
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
      `DTSTAMP:${formatDateIcs(data.schedule.updatedAt)}Z`,
      `DTSTART;TZID=Europe/Kyiv:${formatDateIcs(event.start)}`,
      `DTEND;TZID=Europe/Kyiv:${formatDateIcs(event.end)}`,
      `SUMMARY:${escapeIcs(`Power outage (group ${data.group})`)}`,
      `LOCATION:${escapeIcs(location)}`,
      `DESCRIPTION:${escapeIcs(`Updated at ${formatDate(data.schedule.updatedAt)}`)}`,
      'END:VEVENT',
    )
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}
