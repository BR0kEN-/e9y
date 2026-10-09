import express from 'express'
import puppeteer from 'puppeteer-core'

import { basicAuth } from './src/auth.js'
import { Cache } from './src/cache.js'
import { buildDtekStatus, buildIcs, collectDtek } from './src/dtek.js'
import { checkNerc, dateToTimestamp, findGreenTariffByDate } from './src/nerc.js'

process.env.TZ = 'Europe/Kyiv'
process.env.LOCALE = 'uk-UA'

const DTEK_REGIONS = new Set(['dnem', 'kem', 'krem', 'oem'])
const NERC_CACHE_KEY = 'current-decree'

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback)

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  return value
}

function query(request, name) {
  const value = request.query[name]

  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`Missing query parameter: ${name}`)
    error.status = 400
    throw error
  }

  return value.trim().replace(/\s+/g, ' ')
}

function optionalQuery(request, name) {
  const value = request.query[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function required(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

function loadDtekCookies() {
  const json = process.env.DTEK_COOKIES_JSON

  return json ? JSON.parse(json) : {}
}

function setCacheHeaders(response, cached) {
  response.set({
    'Cache-Control': 'no-cache',
    'X-Cache': cached.status.toUpperCase(),
    'X-Fetched-At': new Date(cached.fetchedAt).toISOString(),
  })
}

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: integer('PORT', 8085),
  navigationTimeout: integer('PUPPETEER_NAVIGATION_TIMEOUT_MS', 30_000),
  dtekCookies: loadDtekCookies(),
  username: required('BASIC_AUTH_USERNAME'),
  password: required('BASIC_AUTH_PASSWORD'),
}
const dtekCache = new Cache(integer('DTEK_CACHE_TTL_SECONDS', 180) * 1000)
const nercCache = new Cache(integer('NERC_CACHE_TTL_SECONDS', 86_400) * 1000)
const browser = await puppeteer.launch({
  headless: 'shell',
  executablePath: required('PUPPETEER_EXECUTABLE_PATH'),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ],
})

async function withPage(callback) {
  const context = await browser.createBrowserContext()

  try {
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(config.navigationTimeout)
    return await callback(page, context)
  } finally {
    await context.close().catch(() => {})
  }
}

const app = express()
app.use(basicAuth(config.username, config.password))

async function loadDtek(address) {
  return withPage((page, context) => collectDtek(
    page,
    context,
    address,
    config.dtekCookies[address.region] || [],
    config.navigationTimeout,
  ))
}

async function getDtek(request) {
  const address = {
    region: query(request, 'region').toLowerCase(),
    locality: query(request, 'locality'),
    street: query(request, 'street'),
    building: query(request, 'building'),
  }

  if (!DTEK_REGIONS.has(address.region)) {
    const error = new Error(`Unsupported DTEK region: ${address.region}`)
    error.status = 400
    throw error
  }

  const key = JSON.stringify(Object.values(address).map((value) => value.toLocaleLowerCase('uk-UA')))
  const cached = await dtekCache.get(key, () => loadDtek(address))

  if (cached.error) {
    console.error('DTEK failed; serving the last result', cached.error)
  }

  return { address, cached }
}

app.get('/dtek/shutdowns.ics', async (request, response) => {
  const { address, cached } = await getDtek(request)

  setCacheHeaders(response, cached)
  response.type('text/calendar').send(buildIcs(address, cached.value))
})

app.get('/dtek/shutdowns.json', async (request, response) => {
  const { cached } = await getDtek(request)
  const previousFingerprint = optionalQuery(request, 'previous_fingerprint')

  setCacheHeaders(response, cached)
  response.json(buildDtekStatus(cached.value, new Date(), previousFingerprint))
})

app.get('/nerc/green-tariff-price', async (request, response) => {
  const date = query(request, 'date')
  const targetTimestamp = dateToTimestamp(date)
  const cached = await nercCache.get(
    NERC_CACHE_KEY,
    () => withPage((page) => checkNerc(page)),
  )

  if (cached.error) {
    console.error('NERC failed; serving the last result', cached.error)
  }

  let tariff

  try {
    tariff = findGreenTariffByDate(cached.value.tariffs, targetTimestamp)
  } catch (error) {
    if (cached.error) {
      const unavailable = new Error('NERC refresh failed and the cached tariff table does not cover this date')
      unavailable.cause = cached.error
      throw unavailable
    }

    throw error
  }

  setCacheHeaders(response, cached)
  response.json({ error: null, tariff, ...cached.value })
})

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }

  console.error(error)
  response.status(error.status || 502).json({ error: error.message })
})

const server = app.listen(config.port, config.host, () => {
  console.info(`e9y-api listening on http://${config.host}:${config.port}`)
})

let closing = false

async function shutdown(signal) {
  if (closing) {
    return
  }

  closing = true
  console.info(`Received ${signal}; shutting down`)
  server.close(async () => browser.close())
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
