# e9y API

A small HTTP API for DTEK outage data and NERC household green tariffs. Run one
instance on a machine with Node.js and Chrome Headless Shell, then use it from
one or more Home Assistant installations. Every route requires HTTP Basic Auth.

## Why this exists

DTEK does not provide a public outage API. The
[ha-yasno-outages](https://github.com/denysdovhan/ha-yasno-outages) integration
is easier to install and may be a better fit for some setups, but its data comes
from the YASNO API and can arrive later than changes on the DTEK website. That
delay matters when an outage schedule changes during the day and Home Assistant
uses it for battery planning, load shifting, or notifications.

This service reads the DTEK website directly. It also reads the latest NERC
decree, so the same service can provide the correct green-tariff price for
installations commissioned on different dates.

## Features

- Gets the current DTEK schedule for addresses in the configured DTEK region.
- Returns DTEK data as JSON and as an ICS calendar for Home Assistant.
- Reports the next outage, next power restoration, current outage reason, and
  the reason's start and end times.
- Provides separate hashes for today's and tomorrow's schedules. The included
  Home Assistant automation uses them without sending a false midnight alert.
- Finds the latest NERC green-tariff decree, reads all of its date ranges, and
  returns the price that applies to the requested commissioning date.
- Retries a failed DTEK crawl once in a fresh browser context, then falls back
  to the last cached result when one exists.
- Caches DTEK data per address and the NERC tariff table once for all dates, so
  repeated requests do not open unnecessary browser sessions.
- Includes Home Assistant examples for REST sensors, an outage calendar, and
  notifications when a schedule or NERC decree changes.
- Keeps no outage history. When DTEK changes a schedule, the API and calendar
  show the new version.

## Configuration

Install the dependencies, then download the pinned Chrome Headless Shell build:

```sh
npm ci
npx @puppeteer/browsers install chrome-headless-shell@150.0.7871.46 --path "$HOME/.cache/e9y-api"
```

The install command prints the browser executable's absolute path. Copy
`.env.example` to `.env`, use that path for `PUPPETEER_EXECUTABLE_PATH`, set a
strong username and password, and adjust the optional DTEK cookie settings if
the selected regional site needs them.

```sh
cp .env.example .env
node --env-file=.env index.js
```

`puppeteer-core` and Chrome Headless Shell are pinned to matching versions that
run on macOS 12 Monterey. `npm install` and `npm ci` never download a browser;
the separate command above performs that explicit download.

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
      "start_date": "2025-01-01",
      "end_date": "2025-12-31",
      "tariff": 6.8001
    },
    {
      "start_date": "2026-01-01",
      "end_date": "2029-12-31",
      "tariff": 6.134
    }
  ],
  "decree": {
    "id": "1613",
    "url": "https://www.nerc.gov.ua/acts/...",
    "published_at": "2026-09-30T16:03:57+03:00"
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
  "updated_at": "2026-10-07T09:00:00.000Z",
  "next_outage": "2026-10-07T12:00:00.000Z",
  "next_connectivity": "2026-10-07T14:00:00.000Z",
  "today": {
    "date": "2026-10-07",
    "hash": "...",
    "has_outages": true
  },
  "tomorrow": {
    "date": "2026-10-08",
    "hash": "...",
    "has_outages": false
  },
  "shutdown": {
    "updated_at": "2026-10-07T09:05:00.000Z",
    "started_at": "2026-10-07T09:00:00.000Z",
    "ends_at": "2026-10-07T11:00:00.000Z",
    "reason": "Екстрені відключення"
  }
}
```

`next_outage`, `next_connectivity`, and `shutdown` are `null` when no matching
transition or current shutdown exists. The ICS response is the read-only
calendar feed.

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
          - updated_at
          - next_outage
          - next_connectivity
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
`state_attr('sensor.dtek_outage_schedule', 'next_outage')`,
`state_attr('sensor.dtek_outage_schedule', 'next_connectivity')`, and
`state_attr('sensor.dtek_outage_schedule', 'shutdown')`.

Add the outage automation below. It compares the entity's previous and current
attributes by actual calendar date, so tomorrow becoming today does not create
a rollover notification. A new nonempty tomorrow schedule sends both the
general schedule-change notification and the separate tomorrow-available
notification. `has_value` rejects a missing, `unknown`, or `unavailable`
current sensor value; an initial update without previous schedule attributes is
ignored.

```yaml
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
    {% if previous_today.date == tomorrow.date %}{{ previous_today.has_outages }}
    {% elif previous_tomorrow.date == tomorrow.date %}{{ previous_tomorrow.has_outages }}
    {% else %}{{ false }}{% endif %}
  today_changed: >-
    {{ (previous_today_hash != '' and previous_today_hash != today.hash)
       or (previous_today_hash == '' and today.has_outages) }}
  tomorrow_changed: >-
    {{ (previous_tomorrow_hash != '' and previous_tomorrow_hash != tomorrow.hash)
       or (previous_tomorrow_hash == '' and tomorrow.has_outages) }}
  tomorrow_available: >-
    {{ tomorrow.has_outages and
       (previous_tomorrow_hash == '' or not (previous_tomorrow_outages | bool)) }}
  affected_days: >-
    {% set days = [] %}
    {% if today_changed | bool %}{% set days = days + ['today'] %}{% endif %}
    {% if tomorrow_changed | bool %}{% set days = days + ['tomorrow'] %}{% endif %}
    {{ days | join(' and ') }}
actions:
  - action: homeassistant.update_entity
    data:
      entity_id:
        - calendar.dtek_dnipro_outages_1_1  # Replace per HA instance.
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
      title: ⚡️ Export price changed!
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

On the Mac that owns `192.168.68.59`, install Node.js 22.12 or newer, clone this
repository, and follow the configuration steps above. A user LaunchAgent can
then run:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>e9y.api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--env-file=/Users/jondoe/e9y/.env</string>
    <string>/Users/jondoe/e9y/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/jondoe/e9y</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/jondoe/e9y/e9y-api.log</string>
  <key>StandardErrorPath</key><string>/Users/jondoe/e9y/e9y-api.error.log</string>
</dict>
</plist>
```

Save it as `~/Library/LaunchAgents/e9y.api.plist`, replace every
absolute path, validate it with `plutil -lint`, and load it with
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/e9y.api.plist`.
The existing tunnel can continue pointing to `http://192.168.68.59:8085`; this
repository does not configure or manage that tunnel.

## Development

```sh
npm install
npm test
BASIC_AUTH_USERNAME=dev BASIC_AUTH_PASSWORD=dev npm start
```
