# e9y API

One Express/Puppeteer service for the DTEK shutdown schedule and the current
NERC household green-tariff decree. Every route requires HTTP Basic Auth.

## Configuration

Install Chrome or Chromium, then copy `.env.example` to `.env`. Set a strong
username and password, set `PUPPETEER_EXECUTABLE_PATH` to that system browser,
and adjust the optional DTEK cookie settings if the selected regional site
needs them. The project uses `puppeteer-core`; `npm install` and `npm ci` never
download a browser.

```sh
cp .env.example .env
npm ci
node --env-file=.env index.js
```

The service listens on `0.0.0.0:8085` by default.

## Usage

### NERC green-tariff price

```text
GET /nerc/green-tariff-price?date=2025-09-01
```

`date` is the installation commissioning date in `YYYY-MM-DD` format. A
successful response contains the selected tariff and every range parsed from
the current decree. This shortened example shows two of those ranges:

```json
{
  "error": null,
  "tariff": 6.8001,
  "tariffs": [
    {
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "tariff": 6.8001
    },
    {
      "startDate": "2026-01-01",
      "endDate": "2029-12-31",
      "tariff": 6.134
    }
  ],
  "decree": {
    "id": "1613",
    "url": "https://www.nerc.gov.ua/acts/...",
    "publishedAt": "2026-09-30T16:03:57+03:00"
  }
}
```

The complete decree table is cached once, not once per requested date.

### DTEK shutdown state

Both DTEK endpoints take the same address query:

```text
GET /dtek/shutdowns.json?region=dnem&locality=Дніпро&street=шосе Запорізьке&building=80
GET /dtek/shutdowns.ics?region=dnem&locality=Дніпро&street=шосе Запорізьке&building=80
```

URL-encode all query values when constructing the real URLs. The JSON response
contains stable hashes for the Kyiv calendar dates represented by `today` and
`tomorrow`:

```json
{
  "fingerprint": "...",
  "group": 1.1,
  "updatedAt": "2026-10-07T09:00:00.000Z",
  "nextOutage": "2026-10-07T12:00:00.000Z",
  "nextConnectivity": "2026-10-07T14:00:00.000Z",
  "today": {
    "date": "2026-10-07",
    "hash": "...",
    "hasOutages": true
  },
  "tomorrow": {
    "date": "2026-10-08",
    "hash": "...",
    "hasOutages": false
  },
  "shutdown": {
    "updatedAt": "2026-10-07T09:05:00.000Z",
    "startedAt": "2026-10-07T09:00:00.000Z",
    "endsAt": "2026-10-07T11:00:00.000Z",
    "reason": "Екстрені відключення"
  }
}
```

`nextOutage` and `nextConnectivity` are `null` when no matching transition
exists. `shutdown` is an empty object when there is no current shutdown, which
allows Home Assistant to read its nested attributes without logging a JSONPath
warning. The ICS response is the read-only calendar feed.

### Home Assistant

The following is guidance to copy into each HA instance and customize. Replace
the URL-encoded address, commissioning date, entity suffixes, and
`notify.notify_all` for that instance.

Add the credentials to `secrets.yaml`:

```yaml
e9y_api_username: your-user
e9y_api_password: your-password
```

Add the REST sensors to `configuration.yaml` or an included package. All
sensors under each resource are populated by one HTTP request:

```yaml
rest:
  - resource: "https://grid-data.example.com/dtek/shutdowns.json?region=dnem&locality=DNIPRO_URL_ENCODED&street=STREET_URL_ENCODED&building=80"
    authentication: basic
    username: !secret e9y_api_username
    password: !secret e9y_api_password
    scan_interval: 180
    sensor:
      - name: DTEK Outage Schedule
        unique_id: dtek_outage_schedule
        value_template: "{{ value_json.fingerprint }}"
        json_attributes:
          - group
          - updatedAt
          - nextOutage
          - nextConnectivity
          - today
          - tomorrow
          - shutdown

  - resource: "https://grid-data.example.com/nerc/green-tariff-price?date=2025-09-01"
    authentication: basic
    username: !secret e9y_api_username
    password: !secret e9y_api_password
    scan_interval: 86400
    sensor:
      - name: Electricity Export Rate
        unique_id: electricity_export_rate
        value_template: "{{ value_json.tariff }}"
        unit_of_measurement: "UAH/kWh"
        json_attributes:
          - decree
```

The DTEK transition times and current shutdown details are attributes of the
same entity for dashboard use. Read them with
`state_attr('sensor.dtek_outage_schedule', 'nextOutage')`,
`state_attr('sensor.dtek_outage_schedule', 'nextConnectivity')`, and
`state_attr('sensor.dtek_outage_schedule', 'shutdown')`.

Add the outage automation below. It compares the entity's previous and current
attributes by actual calendar date, so tomorrow becoming today does not create
a rollover notification. A new nonempty tomorrow schedule sends both the
general schedule-change notification and the separate tomorrow-available
notification. `has_value` rejects a missing, `unknown`, or `unavailable`
current sensor value; an initial update without previous schedule attributes is
ignored.

```yaml
id: e9y_api_dtek_schedule_notifications
alias: e9y API - DTEK schedule notifications
mode: queued
triggers:
  - platform: state
    entity_id: sensor.dtek_outage_schedule
conditions:
  - condition: template
    value_template: >-
      {{ trigger.from_state is not none
         and has_value(trigger.entity_id)
         and trigger.from_state.attributes.today is mapping
         and trigger.from_state.attributes.tomorrow is mapping
         and trigger.to_state.attributes.today is mapping
         and trigger.to_state.attributes.tomorrow is mapping }}
variables:
  previous_today: "{{ trigger.from_state.attributes.today }}"
  previous_tomorrow: "{{ trigger.from_state.attributes.tomorrow }}"
  today: "{{ trigger.to_state.attributes.today }}"
  tomorrow: "{{ trigger.to_state.attributes.tomorrow }}"
  previous_today_hash: >-
    {% if previous_today.date == today.date %}{{ previous_today.hash }}
    {% elif previous_tomorrow.date == today.date %}{{ previous_tomorrow.hash }}
    {% else %}{{ '' }}{% endif %}
  previous_tomorrow_hash: >-
    {% if previous_today.date == tomorrow.date %}{{ previous_today.hash }}
    {% elif previous_tomorrow.date == tomorrow.date %}{{ previous_tomorrow.hash }}
    {% else %}{{ '' }}{% endif %}
  previous_tomorrow_outages: >-
    {% if previous_today.date == tomorrow.date %}{{ previous_today.hasOutages }}
    {% elif previous_tomorrow.date == tomorrow.date %}{{ previous_tomorrow.hasOutages }}
    {% else %}{{ false }}{% endif %}
  today_changed: >-
    {{ (previous_today_hash != '' and previous_today_hash != today.hash)
       or (previous_today_hash == '' and today.hasOutages) }}
  tomorrow_changed: >-
    {{ (previous_tomorrow_hash != '' and previous_tomorrow_hash != tomorrow.hash)
       or (previous_tomorrow_hash == '' and tomorrow.hasOutages) }}
  tomorrow_available: >-
    {{ tomorrow.hasOutages and
       (previous_tomorrow_hash == '' or not (previous_tomorrow_outages | bool)) }}
  affected_days: >-
    {% set days = [] %}
    {% if today_changed | bool %}{% set days = days + ['today'] %}{% endif %}
    {% if tomorrow_changed | bool %}{% set days = days + ['tomorrow'] %}{% endif %}
    {{ days | join(' and ') }}
actions:
  - choose:
      - conditions:
          - condition: template
            value_template: >-
              {{ today_changed | bool or tomorrow_changed | bool }}
        sequence:
          - variables:
              notification:
                message: 🔌 The outage schedule has changed!
  - choose:
      - conditions:
          - condition: template
            value_template: "{{ tomorrow_available | bool }}"
        sequence:
          - variables:
              notification:
                message: 🔌 Morrow's outage schedule dropped!
  - alias: Notify
    if:
      - condition: template
        value_template: '{{ notification is defined }}'
    then:
      - action: notify.notify_all
        data:
          message: '{{ notification.message }}'
      - action: telegram_bot.send_message
        metadata: {}
        data:
          message: |-
            {{ notification.message }}

            Check it out in the @NestWatchdogBot
          parse_mode: plain_text
          config_entry_id: 01KE01C6X423DYR165PHVBD5VB
          entity_id:
            - notify.watchdog_nestwatchdog_1002710792988
```

Add the NERC automation. It watches the `decree` attribute, so a tariff that
happens to remain unchanged does not hide a new decree. `has_value` rejects a
missing, `unknown`, or `unavailable` current sensor value; an initial update
without a previous decree attribute is ignored.

```yaml
automation:
  - id: e9y_api_nerc_decree_notifications
    alias: e9y API - NERC decree notifications
    mode: queued
    trigger:
      - platform: state
        entity_id: sensor.electricity_export_rate
    condition:
      - condition: template
        value_template: >-
          {{ trigger.from_state is not none
             and has_value(trigger.entity_id)
             and trigger.from_state.attributes.decree is mapping
             and trigger.to_state.attributes.decree is mapping
             and trigger.from_state.attributes.decree
                 != trigger.to_state.attributes.decree }}
    variables:
      decree: "{{ trigger.to_state.attributes.decree }}"
    action:
      - action: notify.notify_all # Replace per HA instance.
        data:
          title: NERC decree changed
          message: >-
            Decree {{ decree.id }}, tariff {{ trigger.to_state.state }} UAH/kWh.
            {{ decree.url }}
```

For the calendar, add the **Remote Calendar** integration in the HA UI. Use the
authenticated `.ics` URL, select HTTP Basic Auth, and enter the same username
and password. Keep the REST sensor as well: the calendar provides events while
the JSON sensor provides deterministic change detection.

## Cache

```text
DTEK_CACHE_TTL_SECONDS=180
NERC_CACHE_TTL_SECONDS=86400
```

DTEK results are cached per normalized address. NERC has one cache entry for
the current decree and its complete tariff table, so all commissioning dates
reuse the same crawl. Concurrent misses share the in-flight crawl. If a refresh
fails, the last successful value is served with `X-Cache: STALE` when it can
answer the request.

## Native macOS service

On the Mac that owns `192.168.68.59`, install Node.js 22.12 or newer and Google
Chrome or Chromium, clone this repository, run `npm ci`, and create `.env`. A
user LaunchAgent can then run:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>e9y.api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--env-file=/ABSOLUTE/PATH/e9y-api/.env</string>
    <string>/ABSOLUTE/PATH/e9y-api/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/e9y-api</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/ABSOLUTE/PATH/e9y-api/e9y-api.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/e9y-api/e9y-api.error.log</string>
</dict>
</plist>
```

Save it as `~/Library/LaunchAgents/e9y.api.plist`, replace every
absolute path, validate it with `plutil -lint`, and load it with
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/e9y.api.plist`.
The existing tunnel can continue pointing to `http://192.168.68.59:8085`; this
repository does not configure or manage that tunnel.

## DTEK cookies

Cookies are grouped by region in JSON. Configure either `DTEK_COOKIES_FILE` or
`DTEK_COOKIES_JSON`. See
[`config/dtek-cookies.example.json`](config/dtek-cookies.example.json).

## Development

```sh
npm install
npm test
BASIC_AUTH_USERNAME=dev BASIC_AUTH_PASSWORD=dev npm start
```
