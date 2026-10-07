import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkNerc,
  dateToTimestamp,
  findGreenTariffByDate,
  parseGreenTariffs,
} from '../src/nerc.js'

const DECREE_TITLE = 'Про встановлення «зелених» тарифів на електричну енергію, вироблену генеруючими установками приватних домогосподарств'

const SOURCE = `
Установити на період тариф на електричну енергію, вироблену з енергії сонячного випромінювання
з 01 січня 2020 року по 31 грудня 2024 року — 743,21 коп/кВт·год;
з 01 січня 2025 року по 31 грудня 2029 року — 650,00 коп/кВт·год.
2. Інший розділ
`

const CURRENT_SOURCE = `
1. Установити «зелений» тариф на електричну енергію, вироблену з енергії сонячного випромінювання генеруючими установками приватних домогосподарств, встановлена потужність яких не перевищує 30 кВт та які введені в експлуатацію:
з 01 квітня 2013 року по 31 грудня 2014 року – 1848,52 коп/кВт·год (без ПДВ);
з 01 січня 2015 року по 30 червня 2015 року – 1662,56 коп/кВт·год (без ПДВ);
з 01 липня 2015 року по 31 грудня 2015 року – 1032,51 коп/кВт·год (без ПДВ);
з 01 січня 2016 року по 31 грудня 2016 року – 979,77 коп/кВт·год (без ПДВ);
з 01 січня 2017 року по 31 грудня 2019 року – 932,59 коп/кВт·год (без ПДВ);
з 01 січня 2020 року по 31 грудня 2023 року – 838,22 коп/кВт·год (без ПДВ);
з 01 січня 2024 року по 31 грудня 2024 року – 754,95 коп/кВт·год (без ПДВ);
з 01 січня 2025 року по 31 грудня 2025 року – 680,01 коп/кВт·год (без ПДВ);
з 01 січня 2026 року по 31 грудня 2029 року – 613,40 коп/кВт·год (без ПДВ).
2. Інший розділ
`

test('parses every NERC tariff band and selects inclusive boundaries', () => {
  const tariffs = parseGreenTariffs(SOURCE)

  assert.deepEqual(tariffs, [
    { startDate: '2020-01-01', endDate: '2024-12-31', tariff: 7.4321 },
    { startDate: '2025-01-01', endDate: '2029-12-31', tariff: 6.5 },
  ])
  assert.equal(findGreenTariffByDate(tariffs, Date.UTC(2024, 11, 31)), 7.4321)
  assert.equal(findGreenTariffByDate(tariffs, Date.UTC(2025, 0, 1)), 6.5)
  assert.throws(
    () => findGreenTariffByDate(tariffs, Date.UTC(2030, 0, 1)),
    /No matching date range/,
  )
})

test('validates the commissioning date strictly', () => {
  assert.equal(dateToTimestamp('2025-09-01'), Date.UTC(2025, 8, 1))
  assert.throws(() => dateToTimestamp('2025-02-31'), /Invalid calendar date/)
  assert.throws(() => dateToTimestamp('01.09.2025'), /YYYY-MM-DD/)
})

test('parses all nine ranges from the current decree format', () => {
  const tariffs = parseGreenTariffs(CURRENT_SOURCE)

  assert.equal(tariffs.length, 9)
  assert.deepEqual(tariffs[0], {
    startDate: '2013-04-01',
    endDate: '2014-12-31',
    tariff: 18.4852,
  })
  assert.deepEqual(tariffs.at(-1), {
    startDate: '2026-01-01',
    endDate: '2029-12-31',
    tariff: 6.134,
  })
})

test('finds the current decree through the NERC search API', async () => {
  const responses = [
    {
      data: [{ title: 'Another decree' }],
      current_page: 1,
      next_page_url: '/api/search?page=2',
    },
    {
      data: [{
        title: DECREE_TITLE,
        no: '2222',
        url: '/acts/green-tariff',
        html_content: SOURCE,
        published_at: '2026-10-01T09:00:00+03:00',
      }],
      current_page: 2,
      next_page_url: null,
    },
  ]
  const opened = []
  let scrolls = 0
  const page = {
    setRequestInterception: async () => {},
    on: () => {},
    waitForResponse: async (matches) => {
      assert.equal(matches({ url: () => 'https://www.nerc.gov.ua/api/search?page=1' }), true)
      return { json: async () => responses.shift() }
    },
    goto: async (url) => opened.push(url),
    evaluate: async () => { scrolls += 1 },
  }

  assert.deepEqual(await checkNerc(page), {
    tariffs: [
      { startDate: '2020-01-01', endDate: '2024-12-31', tariff: 7.4321 },
      { startDate: '2025-01-01', endDate: '2029-12-31', tariff: 6.5 },
    ],
    decree: {
      id: '2222',
      url: '/acts/green-tariff',
      publishedAt: '2026-10-01T09:00:00+03:00',
    },
  })
  assert.equal(opened.length, 1)
  assert.match(opened[0], /^https:\/\/www\.nerc\.gov\.ua\/npasearch\?&key=/)
  assert.equal(scrolls, 1)
})

test('rejects an overlapping tariff table instead of caching partial data', () => {
  const source = `
Установити на період тариф на електричну енергію, вироблену з енергії сонячного випромінювання
з 01 січня 2025 року по 31 грудня 2026 року — 650,00 коп/кВт·год;
з 01 січня 2026 року по 31 грудня 2027 року — 620,00 коп/кВт·год.
2. Інший розділ
`

  assert.throws(() => parseGreenTariffs(source), /Overlapping green-tariff range/)
})
