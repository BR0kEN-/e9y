const TARGET_URL = 'https://www.nerc.gov.ua'
const SEARCH_URL = `${TARGET_URL}/api/search`
const DECREE_TITLE = 'Про встановлення «зелених» тарифів на електричну енергію, вироблену генеруючими установками приватних домогосподарств'
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'media', 'font'])
const MONTHS = {
  'січня': 0,
  'лютого': 1,
  'березня': 2,
  'квітня': 3,
  'травня': 4,
  'червня': 5,
  'липня': 6,
  'серпня': 7,
  'вересня': 8,
  'жовтня': 9,
  'листопада': 10,
  'грудня': 11,
}
const SOLAR_BLOCK = /\s+Установити\s+.+\s+тариф\s+на\s+електричну\s+енергію,\s+вироблену\s+з\s+енергії\s+сонячного\s+випромінювання[\s\S]*?(?=2\.|$)/i
const DATE_RANGE = /з\s+(\d{2})\s+([а-яіїє]+)\s+(\d{4})\s+року\s+по\s+(\d{2})\s+([а-яіїє]+)\s+(\d{4})\s+року/i
const PRICE = /([\d,.]+)\s*коп\/квт/i

export function dateToTimestamp(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const error = new Error('Invalid date: use the YYYY-MM-DD format')
    error.status = 400
    throw error
  }

  const [year, month, day] = date.split('-').map(Number)
  const timestamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(timestamp)

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    const error = new Error('Invalid calendar date')
    error.status = 400
    throw error
  }

  return timestamp
}

function dateFromParts(day, month, year) {
  const monthIndex = MONTHS[month.toLowerCase()]

  if (monthIndex === undefined) {
    throw new Error(`Unknown Ukrainian month: ${month}`)
  }

  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day}`
}

export function parseGreenTariffs(rawText) {
  const solarBlock = rawText.match(SOLAR_BLOCK)

  if (!solarBlock) {
    throw new Error('Solar energy block not found')
  }

  const tariffs = []

  for (const line of solarBlock[0].split('\n')) {
    const match = line.match(DATE_RANGE)

    if (!match) {
      continue
    }

    const [, d1, m1, y1, d2, m2, y2] = match
    const price = line.match(PRICE)

    if (!price) {
      throw new Error('Tariff value not found in a date-range line')
    }

    tariffs.push({
      startDate: dateFromParts(d1, m1, y1),
      endDate: dateFromParts(d2, m2, y2),
      tariff: Number((Number(price[1].replace(',', '.')) / 100).toFixed(4)),
    })
  }

  if (!tariffs.length) {
    throw new Error('No green-tariff date ranges found')
  }

  tariffs.sort((left, right) => left.startDate.localeCompare(right.startDate))

  for (const [index, tariff] of tariffs.entries()) {
    const start = dateToTimestamp(tariff.startDate)
    const end = dateToTimestamp(tariff.endDate)

    if (start > end) {
      throw new Error(`Invalid green-tariff range: ${tariff.startDate} to ${tariff.endDate}`)
    }

    if (!Number.isFinite(tariff.tariff) || tariff.tariff <= 0) {
      throw new Error(`Invalid green-tariff value for ${tariff.startDate}`)
    }

    if (index > 0 && start <= dateToTimestamp(tariffs[index - 1].endDate)) {
      throw new Error(`Overlapping green-tariff range at ${tariff.startDate}`)
    }
  }

  return tariffs
}

export function findGreenTariffByDate(tariffs, targetTimestamp) {
  const matching = tariffs.find(({ startDate, endDate }) => (
    targetTimestamp >= dateToTimestamp(startDate)
    && targetTimestamp <= dateToTimestamp(endDate)
  ))

  if (!matching) {
    const error = new Error('No matching date range found')
    error.status = 400
    throw error
  }

  return matching.tariff
}

export async function checkNerc(page) {
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const action = BLOCKED_RESOURCE_TYPES.has(request.resourceType())
      ? request.abort('blockedbyclient')
      : request.continue()
    action.catch(() => {})
  })

  const waitForSearchResponse = async (action) => {
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url().startsWith(SEARCH_URL)),
      action(),
    ])

    return response
  }

  let currentDecree
  let currentPage = -1
  let response = await waitForSearchResponse(
    () => page.goto(`${TARGET_URL}/npasearch?&key=${encodeURIComponent(DECREE_TITLE)}`),
  )

  while (true) {
    const { data, current_page, next_page_url } = await response.json()

    if (current_page === currentPage) {
      throw new Error('Navigation did not happen!')
    }

    for (const item of data) {
      if (item.title === DECREE_TITLE) {
        currentDecree = item
        break
      }
    }

    if (currentDecree || !next_page_url) {
      break
    }

    currentPage = current_page
    response = await waitForSearchResponse(
      () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)),
    )
  }

  if (!currentDecree) {
    throw new Error('Cannot find a decree!')
  }

  if (
    !currentDecree.no
    || !currentDecree.url
    || !currentDecree.html_content
    || !currentDecree.published_at
  ) {
    throw new Error('Unexpected response!')
  }

  return {
    tariffs: parseGreenTariffs(currentDecree.html_content),
    decree: {
      id: currentDecree.no,
      url: currentDecree.url,
      publishedAt: currentDecree.published_at,
    },
  }
}
