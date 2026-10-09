const CARD_TAG = "dtek-outage-card";
const DEFAULT_ENTITY = "sensor.dtek_outage_schedule";
const DEFAULT_ICON = "mdi:calendar-today-outline";
const DEFAULT_GROUP_ICON = "mdi:human-queue";
const UNAVAILABLE_STATES = new Set(["unknown", "unavailable"]);
const HALF_HOUR_MINUTES = 30;
const MINUTES_PER_DAY = 24 * 60;
const TRANSLATIONS = Object.freeze({
  en: {
    title: "Outages",
    group: "Group",
    next_outage: "Next outage",
    next_connectivity: "Power restoration",
    no_outages: "Not planned",
    today: "Today",
    tomorrow: "Tomorrow",
    schedule_updated: "Schedule changed",
    last_checked: "Checked",
    yesterday: "Yesterday",
    at: "at",
  },
  uk: {
    title: "Відключення",
    group: "Група",
    next_outage: "Наступне відключення",
    next_connectivity: "Відновлення живлення",
    no_outages: "Не заплановано",
    today: "Сьогодні",
    tomorrow: "Завтра",
    schedule_updated: "Графік змінено",
    last_checked: "Перевірено",
    yesterday: "Учора",
    at: "о",
  },
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value);

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function dateKeyFromParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function dateKey(date, timeZone) {
  return dateKeyFromParts(dateParts(date, timeZone));
}

function addCalendarDays(key, days) {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function minutesOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

function eventDateValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.dateTime || value.date || null;
  return null;
}

function splitToLocalDays(startValue, endValue, timeZone) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return [];

  const segments = [];
  let cursor = start.getTime();
  const endTime = end.getTime();

  while (cursor < endTime) {
    const cursorParts = dateParts(new Date(cursor), timeZone);
    const cursorKey = dateKeyFromParts(cursorParts);
    const probe = Math.min(cursor + 30 * 60 * 60 * 1_000, endTime);
    let boundary = probe;

    if (dateKey(new Date(probe), timeZone) !== cursorKey) {
      let low = cursor;
      let high = probe;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (dateKey(new Date(middle), timeZone) === cursorKey) low = middle;
        else high = middle;
      }
      boundary = high;
    }

    const segmentEnd = Math.min(boundary, endTime);
    const endParts = dateParts(new Date(segmentEnd), timeZone);
    const endKey = dateKeyFromParts(endParts);
    const startMinute = minutesOfDay(cursorParts);
    const endMinute = endKey === cursorKey ? minutesOfDay(endParts) : MINUTES_PER_DAY;

    if (endMinute > startMinute) {
      segments.push({ dayKey: cursorKey, startMinute, endMinute });
    }

    if (segmentEnd <= cursor) break;
    cursor = segmentEnd;
  }

  return segments;
}

function mergeSegments(segments) {
  const ordered = segments
    .map((segment) => ({ ...segment }))
    .sort((left, right) => left.startMinute - right.startMinute);
  const merged = [];

  for (const segment of ordered) {
    const previous = merged.at(-1);
    if (previous && segment.startMinute <= previous.endMinute) {
      previous.endMinute = Math.max(previous.endMinute, segment.endMinute);
    } else {
      merged.push(segment);
    }
  }

  return merged;
}

function segmentsOverlap(left, right) {
  return Math.max(left.startMinute, right.startMinute)
    < Math.min(left.endMinute, right.endMinute);
}

function nextLocalDayDelay(timeZone) {
  const now = Date.now();
  const currentKey = dateKey(new Date(now), timeZone);
  let low = now;
  let high = now + 30 * 60 * 60 * 1_000;

  while (dateKey(new Date(high), timeZone) === currentKey) {
    high += 24 * 60 * 60 * 1_000;
  }

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dateKey(new Date(middle), timeZone) === currentKey) low = middle;
    else high = middle;
  }

  return Math.max(1_000, high - now + 1_000);
}

class DtekOutageCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._stateSignature = null;
    this._headingRender = 0;
    this._headingCard = null;
    this._headingConfigSignature = null;
    this._cardHelpersPromise = null;
    this._dayRefreshTimer = null;
    this._transitionRefreshTimer = null;
    this._expandedDays = new Set();
    this._timeZone = null;
  }

  static getStubConfig() {
    return {
      entity: DEFAULT_ENTITY,
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Card configuration is required");
    if (config.testing_config !== undefined
      && (!config.testing_config || typeof config.testing_config !== "object" || Array.isArray(config.testing_config))) {
      throw new Error("testing_config must be an object");
    }
    this.config = {
      entity: DEFAULT_ENTITY,
      icon: DEFAULT_ICON,
      group_icon: DEFAULT_GROUP_ICON,
      ...config,
    };
    this._headingCard = null;
    this._headingConfigSignature = null;
    this._expandedDays.clear();
    this._stateSignature = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._headingCard) this._headingCard.hass = this._headingHass();
    const timeZone = this._getTimeZone();
    if (timeZone !== this._timeZone) {
      this._timeZone = timeZone;
      this._scheduleDayRefresh();
    }

    const signature = this._relevantStateSignature();
    if (signature !== this._stateSignature) {
      this._stateSignature = signature;
      this._render();
    }
  }

  connectedCallback() {
    this._scheduleDayRefresh();
  }

  disconnectedCallback() {
    if (this._dayRefreshTimer) window.clearTimeout(this._dayRefreshTimer);
    if (this._transitionRefreshTimer) window.clearTimeout(this._transitionRefreshTimer);
    this._dayRefreshTimer = null;
    this._transitionRefreshTimer = null;
    this._headingRender += 1;
    this._headingCard = null;
    this._headingConfigSignature = null;
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return {
      columns: "full",
      min_columns: 6,
    };
  }

  _getTimeZone() {
    return this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  _getLocale() {
    return this._hass?.locale?.language || navigator.language || "en";
  }

  _translate(key) {
    const language = this._getLocale().toLowerCase().split("-")[0];
    return (TRANSLATIONS[language] || TRANSLATIONS.en)[key] || TRANSLATIONS.en[key] || key;
  }

  _isTesting() {
    return Boolean(this.config?.testing_config);
  }

  _sensorState() {
    if (this._isTesting()) {
      const {
        last_reported: lastReported,
        last_updated: lastUpdated,
        ...attributes
      } = this.config.testing_config;
      return {
        entity_id: this.config.entity,
        state: "testing",
        last_reported: lastReported || null,
        last_updated: lastUpdated || null,
        attributes,
      };
    }
    return this._hass?.states?.[this.config?.entity];
  }

  _isAvailable(state) {
    return Boolean(state) && !UNAVAILABLE_STATES.has(state.state);
  }

  _dayKeys() {
    const today = dateKey(new Date(), this._getTimeZone());
    return { today, tomorrow: addCalendarDays(today, 1) };
  }

  _relevantStateSignature() {
    if (!this.config || !this._hass) return null;
    const sensor = this._sensorState();
    const attributes = sensor?.attributes || {};

    return JSON.stringify([
      sensor?.state,
      sensor?.last_reported,
      sensor?.last_updated,
      attributes.group,
      attributes.updated_at,
      attributes.checked_at,
      attributes.today,
      attributes.tomorrow,
      attributes.events,
      attributes.shutdown,
      this._getTimeZone(),
      this._getLocale(),
      this._hass?.themes?.darkMode,
    ]);
  }

  _scheduleDayRefresh() {
    if (this._dayRefreshTimer) window.clearTimeout(this._dayRefreshTimer);
    this._dayRefreshTimer = null;
    if (!this.isConnected || !this._hass) return;

    this._dayRefreshTimer = window.setTimeout(() => {
      this._stateSignature = null;
      this._render();
      this._scheduleDayRefresh();
    }, nextLocalDayDelay(this._getTimeZone()));
  }

  _scheduleTransitionRefresh(...transitions) {
    if (this._transitionRefreshTimer) window.clearTimeout(this._transitionRefreshTimer);
    this._transitionRefreshTimer = null;
    if (!this.isConnected) return;

    const now = Date.now();
    const next = transitions
      .map((transition) => transition?.getTime())
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
      .sort((left, right) => left - right)[0];
    if (!next) return;

    this._transitionRefreshTimer = window.setTimeout(() => {
      this._transitionRefreshTimer = null;
      this._render();
    }, Math.min(next - now + 1_000, 2_147_483_647));
  }

  _events() {
    const sensor = this._sensorState();
    if (!this._isAvailable(sensor)) return [];
    return Array.isArray(sensor.attributes.events) ? sensor.attributes.events : [];
  }

  _eventSegments() {
    const timeZone = this._getTimeZone();
    const days = this._dayKeys();
    const byDay = new Map([
      [days.today, []],
      [days.tomorrow, []],
    ]);

    for (const event of this._events()) {
      const start = eventDateValue(event.start);
      const end = eventDateValue(event.end);
      if (!start || !end) continue;

      for (const segment of splitToLocalDays(start, end, timeZone)) {
        if (byDay.has(segment.dayKey)) byDay.get(segment.dayKey).push(segment);
      }
    }

    for (const [key, segments] of byDay) byDay.set(key, mergeSegments(segments));
    return byDay;
  }

  _eventTransitions(shutdown, now = new Date()) {
    const intervals = [];

    for (const event of this._events()) {
      const startValue = eventDateValue(event.start);
      const endValue = eventDateValue(event.end);
      if (!startValue || !endValue) continue;
      const start = new Date(startValue);
      const end = new Date(endValue);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;
      intervals.push({ start, end });
    }

    const shutdownStart = this._validDate(shutdown?.started_at);
    const shutdownEnd = this._validDate(shutdown?.ends_at);
    if (shutdownStart && shutdownEnd && shutdownEnd > shutdownStart) {
      intervals.push({ start: shutdownStart, end: shutdownEnd });
    }

    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.start <= previous.end) {
        if (interval.end > previous.end) previous.end = interval.end;
      } else {
        merged.push(interval);
      }
    }

    let nextOutage = null;
    let nextConnectivity = null;
    for (const interval of merged) {
      if (interval.start <= now && now < interval.end) {
        nextConnectivity ||= interval.end;
      } else if (interval.start > now) {
        nextOutage ||= interval.start;
        nextConnectivity ||= interval.end;
      }
      if (nextOutage && nextConnectivity) break;
    }

    return { nextOutage, nextConnectivity };
  }

  _hasSensorContent(state) {
    const attributes = state?.attributes || {};
    const shutdown = attributes.shutdown;
    const hasShutdown = shutdown
      && typeof shutdown === "object"
      && Boolean(
        shutdown.reason
        || this._validDate(shutdown.started_at)
        || this._validDate(shutdown.ends_at)
      );
    return Boolean(hasShutdown);
  }

  _validDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  _exactDate(value) {
    const date = this._validDate(value);
    if (!date) return "Unknown";
    const options = {
      timeZone: this._getTimeZone(),
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    const timeFormat = this._hass?.locale?.time_format;
    if (["am_pm", "12"].includes(timeFormat)) options.hour12 = true;
    if (["twenty_four", "24"].includes(timeFormat)) options.hour12 = false;
    return new Intl.DateTimeFormat(this._getLocale(), options).format(date);
  }

  _timeFormatOptions() {
    const options = {
      timeZone: this._getTimeZone(),
      hour: "2-digit",
      minute: "2-digit",
    };
    const timeFormat = this._hass?.locale?.time_format;
    if (["am_pm", "12"].includes(timeFormat)) options.hour12 = true;
    if (["twenty_four", "24"].includes(timeFormat)) options.hour12 = false;
    return options;
  }

  _formatTime(value) {
    const date = this._validDate(value);
    if (!date) return "";
    return new Intl.DateTimeFormat(this._getLocale(), this._timeFormatOptions()).format(date);
  }

  _formatChangedTime(value) {
    const date = this._validDate(value);
    if (!date) return "";
    const key = dateKey(date, this._getTimeZone());
    const days = this._dayKeys();
    const yesterday = addCalendarDays(days.today, -1);
    const relative = key === days.today
      ? this._translate("today")
      : key === days.tomorrow
        ? this._translate("tomorrow")
        : key === yesterday
          ? this._translate("yesterday")
          : null;

    if (relative) {
      return `${relative.toLocaleLowerCase(this._getLocale())} ${this._translate("at")} ${this._formatTime(date)}`;
    }

    return new Intl.DateTimeFormat(this._getLocale(), {
      timeZone: this._getTimeZone(),
      year: "numeric",
      month: "short",
      day: "numeric",
      ...this._timeFormatOptions(),
    }).format(date);
  }

  _relativeDateMarkup(value, capitalize = false) {
    const date = this._validDate(value);
    if (!date) return "";
    const iso = date.toISOString();
    return `
      <div class="relative">
        <ha-relative-time data-datetime="${escapeHtml(iso)}" data-capitalize="${capitalize}"></ha-relative-time>
      </div>
      <div class="exact">${escapeHtml(this._exactDate(date))}</div>
    `;
  }

  _relativeInlineMarkup(value) {
    const date = this._validDate(value);
    if (!date) return "";
    return `<ha-relative-time class="footer-relative" data-datetime="${escapeHtml(date.toISOString())}"></ha-relative-time>`;
  }

  _formatDayLabel(key, relativeLabel) {
    const [year, month, day] = key.split("-").map(Number);
    const anchor = new Date(Date.UTC(year, month - 1, day, 12));
    const date = new Intl.DateTimeFormat(this._getLocale(), {
      timeZone: this._getTimeZone(),
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(anchor);
    return `${relativeLabel} · ${date}`;
  }

  _formatFullDayLabel(key) {
    const [year, month, day] = key.split("-").map(Number);
    const anchor = new Date(Date.UTC(year, month - 1, day, 12));
    return new Intl.DateTimeFormat(this._getLocale(), {
      timeZone: this._getTimeZone(),
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(anchor);
  }

  _formatMinute(minute) {
    if (minute >= MINUTES_PER_DAY) return "24:00";
    return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
  }

  _formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const language = this._getLocale().toLowerCase().split("-")[0];
    const parts = [];

    if (hours) parts.push(language === "uk" ? `${hours} год` : `${hours}h`);
    if (remainder || !hours) parts.push(language === "uk" ? `${remainder} хв` : `${remainder}m`);
    return parts.join(" ");
  }

  _formatOutageCount(count) {
    const language = this._getLocale().toLowerCase().split("-")[0];
    if (language !== "uk") return `${count} outage${count === 1 ? "" : "s"}`;
    const singular = count % 10 === 1 && count % 100 !== 11;
    const few = [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100);
    return `${count} ${singular || few ? "відключення" : "відключень"}`;
  }

  _renderStatus(labelKey, icon, date) {
    return `<div class="status">
      <div class="status-icon"><ha-icon icon="${icon}"></ha-icon></div>
      <div>
        <div class="status-label">${escapeHtml(this._translate(labelKey))}</div>
        ${this._relativeDateMarkup(date, true)}
      </div>
    </div>`;
  }

  _renderTimelineBar(slots, startHour, isToday, nowMinute, extraClass = "") {
    const startMinute = startHour * 60;
    const duration = slots.length * HALF_HOUR_MINUTES;
    const showsNow = isToday && nowMinute >= startMinute && nowMinute < startMinute + duration;
    const nowPosition = showsNow
      ? (nowMinute - startMinute) / duration * 100
      : 0;
    const hourCount = slots.length / 2;

    return `
      <div class="timeline${extraClass ? ` ${extraClass}` : ""}">
        <div class="slots">
          ${slots.map((slot, index) => `<span class="slot${slot.planned ? " outage" : ""}${slot.shutdown ? " shutdown" : ""}${index % 2 === 0 ? " hour-start" : " half-start"}"></span>`).join("")}
        </div>
        <div class="hour-cells" aria-hidden="true">
          ${Array.from({ length: hourCount }, (_, index) => `<span>${startHour + index}</span>`).join("")}
        </div>
        ${showsNow ? `<span class="now-marker" style="left: ${nowPosition.toFixed(3)}%"></span>` : ""}
      </div>
    `;
  }

  _renderTimelineDay(
    key,
    plannedSegments,
    shutdownSegments,
    isToday,
    relativeLabel = null,
    scope = "schedule",
  ) {
    const slots = Array.from({ length: MINUTES_PER_DAY / HALF_HOUR_MINUTES }, (_, index) => {
      const start = index * HALF_HOUR_MINUTES;
      const end = start + HALF_HOUR_MINUTES;
      const overlapsSlot = (segment) => Math.max(segment.startMinute, start) < Math.min(segment.endMinute, end);
      return {
        planned: plannedSegments.some(overlapsSlot),
        shutdown: shutdownSegments.some(overlapsSlot),
      };
    });
    const intervals = [...plannedSegments, ...shutdownSegments].map(
      (segment) => `${this._formatMinute(segment.startMinute)}–${this._formatMinute(segment.endMinute)}`,
    ).join(" · ");
    const nowParts = dateParts(new Date(), this._getTimeZone());
    const label = relativeLabel
      ? this._formatDayLabel(key, relativeLabel)
      : this._formatFullDayLabel(key);
    const aria = `${label}. ${intervals}`;
    const dayId = `${scope}:${key}`;
    const agendaId = `${scope}-${key}-agenda`;
    const expanded = this._expandedDays.has(dayId);
    const summarySegments = scope === "shutdown" ? shutdownSegments : plannedSegments;
    const totalMinutes = summarySegments.reduce(
      (total, segment) => total + segment.endMinute - segment.startMinute,
      0,
    );
    const summary = summarySegments.length
      ? `${this._formatOutageCount(summarySegments.length)} · ${this._formatDuration(totalMinutes)}`
      : "";
    const agenda = [
      ...plannedSegments.map((segment) => ({
        ...segment,
        source: "planned",
        overlap: false,
      })),
      ...shutdownSegments.map((segment) => ({
        ...segment,
        source: "shutdown",
        overlap: plannedSegments.some((other) => segmentsOverlap(segment, other)),
      })),
    ].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
    const nowMinute = minutesOfDay(nowParts);

    return `
      <section class="timeline-day${expanded ? " expanded" : ""}" data-day-id="${escapeHtml(dayId)}">
        <div class="day-head">
          <button class="day-toggle" type="button" aria-expanded="${expanded}" aria-controls="${escapeHtml(agendaId)}">
            <span class="day-label">${escapeHtml(label)}</span>
            <ha-icon class="expand-icon" icon="mdi:chevron-right"></ha-icon>
          </button>
          ${summary ? `<span class="day-summary">${escapeHtml(summary)}</span>` : ""}
        </div>
        <div class="day-agenda" id="${escapeHtml(agendaId)}">
          ${agenda.map((segment) => `
            <div class="agenda-event">
              <span class="agenda-mark ${segment.overlap ? "overlap" : segment.source}"></span>
              <strong>${escapeHtml(`${this._formatMinute(segment.startMinute)}–${this._formatMinute(segment.endMinute)}`)}</strong>
              <span>${escapeHtml(this._formatDuration(segment.endMinute - segment.startMinute))}</span>
            </div>
          `).join("")}
        </div>
        <div class="timeline-viewport" role="img" aria-label="${escapeHtml(aria)}">
          <div class="timeline-rows">
            ${this._renderTimelineBar(slots.slice(0, 24), 0, isToday, nowMinute, "timeline-half")}
            ${this._renderTimelineBar(slots.slice(24), 12, isToday, nowMinute, "timeline-half")}
          </div>
        </div>
      </section>
    `;
  }

  _headingConfig() {
    return {
      type: "heading",
      heading_style: "title",
      heading: this.config.title || this._translate("title"),
      icon: this.config.icon,
    };
  }

  _headingHass() {
    if (!this._isTesting()) return this._hass;

    return {
      ...this._hass,
      states: {
        ...this._hass.states,
        [this.config.entity]: this._sensorState(),
      },
    };
  }

  async _mountHeading(host, render) {
    if (!host || typeof window.loadCardHelpers !== "function") return;

    try {
      this._cardHelpersPromise ||= window.loadCardHelpers();
      const helpers = await this._cardHelpersPromise;
      const heading = await helpers.createCardElement(this._headingConfig());
      if (render !== this._headingRender) return;
      heading.hass = this._headingHass();
      this._headingCard = heading;
      host.replaceChildren(heading);
    } catch (error) {
      if (render === this._headingRender) {
        console.error("Could not create the Home Assistant heading card", error);
      }
    }
  }

  _setDayExpanded(day, expanded) {
    const dayId = day.dataset.dayId;
    if (expanded) this._expandedDays.add(dayId);
    else this._expandedDays.delete(dayId);
    day.classList.toggle("expanded", expanded);
    day.querySelector(".day-toggle")?.setAttribute("aria-expanded", String(expanded));
  }

  _bindInteractions() {
    this.shadowRoot.querySelectorAll(".timeline-day").forEach((day) => {
      day.querySelector(".day-toggle")?.addEventListener("click", () => {
        this._setDayExpanded(day, !day.classList.contains("expanded"));
      });
    });
  }

  _render() {
    if (!this.config || !this._hass) return;
    const headingRender = ++this._headingRender;
    const headingConfigSignature = JSON.stringify(this._headingConfig());
    const reusableHeading = headingConfigSignature === this._headingConfigSignature
      ? this._headingCard
      : null;
    if (!reusableHeading) {
      this._headingCard = null;
      this._headingConfigSignature = headingConfigSignature;
    }

    const sensor = this._sensorState();
    const sensorAvailable = this._isAvailable(sensor);
    const attributes = sensor?.attributes || {};
    const shutdown = attributes.shutdown
      && typeof attributes.shutdown === "object"
      && (attributes.shutdown.reason || attributes.shutdown.started_at || attributes.shutdown.ends_at)
      ? attributes.shutdown
      : null;
    const segments = this._eventSegments();
    const days = this._dayKeys();
    const todaySegments = segments.get(days.today) || [];
    const tomorrowSegments = segments.get(days.tomorrow) || [];
    const shutdownStart = this._validDate(shutdown?.started_at);
    const shutdownEnd = this._validDate(shutdown?.ends_at);
    const shutdownSegments = shutdownStart && shutdownEnd && shutdownEnd > shutdownStart
      ? splitToLocalDays(shutdownStart.toISOString(), shutdownEnd.toISOString(), this._getTimeZone())
      : [];
    const todayShutdownSegments = shutdownSegments.filter((segment) => segment.dayKey === days.today);
    const tomorrowShutdownSegments = shutdownSegments.filter((segment) => segment.dayKey === days.tomorrow);
    const shutdownIsIntegrated = todayShutdownSegments.length > 0 || tomorrowShutdownSegments.length > 0;
    const standaloneShutdownSegments = shutdownIsIntegrated ? [] : shutdownSegments;
    const { nextOutage, nextConnectivity } = this._eventTransitions(shutdown);
    this._scheduleTransitionRefresh(nextOutage, nextConnectivity);
    const statusCount = Number(Boolean(nextOutage)) + Number(Boolean(nextConnectivity));
    const hasTimelineContent = todaySegments.length > 0
      || tomorrowSegments.length > 0
      || todayShutdownSegments.length > 0
      || tomorrowShutdownSegments.length > 0;
    const hasSensorContent = sensorAvailable && this._hasSensorContent(sensor);
    const hasOutageContent = hasSensorContent || hasTimelineContent || statusCount > 0;
    const visible = sensorAvailable;

    this.style.display = visible ? "block" : "none";
    if (!visible) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    this.classList.toggle("dark", Boolean(this._hass?.themes?.darkMode));
    const group = attributes.group;
    const dtekChanged = this._validDate(attributes.updated_at);
    const checkedAt = this._validDate(
      attributes.checked_at || sensor?.last_reported || sensor?.last_updated,
    );
    const metadataCount = Number(Boolean(dtekChanged)) + Number(Boolean(checkedAt));
    const noOutagesText = this.config.no_outages_text ?? this._translate("no_outages");
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --dtek-half-tick-neutral: #6b6b6b;
          --dtek-half-tick-outage: #f7f7f7;
          --dtek-hour-divider: color-mix(in srgb, white 72%, transparent);
          --dtek-outage-track: #bababa;
          --dtek-track-background: #eeeeee;
          --dtek-track-label: #202020;
          --dtek-warning-track: #f0b44d;
          display: block;
          min-width: 0;
          width: 100%;
        }

        :host(.dark) {
          --dtek-half-tick-neutral: #9e9e9e;
          --dtek-half-tick-outage: #9e9e9e;
          --dtek-hour-divider: color-mix(in srgb, var(--card-background-color) 72%, transparent);
          --dtek-outage-track: #a93e3a;
          --dtek-track-background: #2b2b2b;
          --dtek-track-label: #ffffff;
          --dtek-warning-track: #8d5c10;
        }

        ha-card {
          box-sizing: border-box;
          container-type: inline-size;
          isolation: isolate;
          overflow: hidden;
          width: 100%;
        }

        .heading-host {
          align-items: center;
          box-sizing: border-box;
          display: grid;
          gap: var(--ha-space-2, 8px);
          grid-template-columns: minmax(0, 1fr) auto;
          margin-bottom: var(--ha-space-2, 8px);
          min-height: 24px;
          padding-right: var(--ha-space-2, 8px);
          width: 100%;
        }

        .heading-card-host {
          min-height: 24px;
          min-width: 0;
        }

        .group-label {
          align-items: center;
          color: var(--secondary-text-color);
          display: inline-flex;
          font-size: var(--ha-font-size-s, 0.875rem);
          gap: 6px;
          white-space: nowrap;
        }

        .group-label ha-icon {
          --mdc-icon-size: 18px;
        }

        .content {
          display: grid;
          gap: 16px;
          padding: 16px;
        }

        .empty-state {
          align-items: center;
          color: var(--secondary-text-color);
          display: flex;
          font-size: var(--ha-font-size-s, 0.875rem);
          gap: var(--ha-space-2, 8px);
        }

        .empty-state ha-icon {
          --mdc-icon-size: 20px;
          color: var(--success-color, #43a047);
        }

        .statuses {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .statuses.single {
          grid-template-columns: 1fr;
        }

        .status {
          align-items: center;
          color: inherit;
          display: grid;
          gap: 12px;
          grid-template-columns: 40px minmax(0, 1fr);
          min-width: 0;
          padding: 8px 16px 8px 0;
          text-align: left;
          width: 100%;
        }

        .status + .status {
          border-left: 1px solid var(--divider-color);
          padding-left: 16px;
          padding-right: 0;
        }

        .status-icon {
          align-items: center;
          background: var(--secondary-background-color);
          border-radius: 50%;
          color: var(--state-icon-color, var(--secondary-text-color));
          display: flex;
          height: 40px;
          justify-content: center;
          width: 40px;
        }

        .status-icon ha-icon {
          --mdc-icon-size: 22px;
        }

        .status-label {
          color: var(--secondary-text-color);
          font-size: var(--ha-font-size-s, 0.875rem);
          line-height: 1.3;
        }

        .relative {
          color: var(--primary-text-color);
          font-size: 1rem;
          font-weight: 600;
          line-height: 1.4;
          margin-top: 3px;
        }

        .exact {
          color: var(--secondary-text-color);
          font-size: var(--ha-font-size-s, 0.875rem);
          line-height: 1.35;
          margin-top: 2px;
        }

        .shutdown {
          border-top: 0;
          padding-top: 0;
        }

        .content > * + .shutdown {
          border-top: 1px solid var(--divider-color);
          padding-top: var(--ha-space-4, 16px);
        }

        .shutdown-heading {
          align-items: center;
          display: flex;
          gap: 6px;
        }

        .shutdown-icon {
          --mdc-icon-size: 18px;
          color: var(--warning-color, #ff9800);
          flex: 0 0 auto;
        }

        .shutdown-reason {
          color: var(--primary-text-color);
          font-size: var(--ha-font-size-s, 0.875rem);
          font-weight: var(--ha-font-weight-medium, 500);
          line-height: var(--ha-line-height-normal, 1.4);
        }

        .shutdown-timeline {
          display: grid;
          gap: 14px;
          margin-top: 0;
        }

        .shutdown-heading + .shutdown-timeline {
          margin-top: var(--ha-space-3, 12px);
        }

        .timeline-section {
          border-top: 0;
          display: grid;
          gap: 14px;
          padding-top: 0;
        }

        .content > * + .timeline-section {
          border-top: 1px solid var(--divider-color);
          padding-top: 14px;
        }

        .timeline-day {
          min-width: 0;
        }

        .day-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .day-summary {
          color: var(--secondary-text-color);
          flex: 0 0 auto;
          font-size: var(--ha-font-size-s, 0.875rem);
          font-weight: var(--ha-font-weight-normal, 400);
          white-space: nowrap;
        }

        .expand-icon {
          --mdc-icon-size: 18px;
          color: var(--secondary-text-color);
          transition: transform 160ms ease;
        }

        .timeline-day.expanded .expand-icon {
          transform: rotate(90deg);
        }

        .timeline-viewport {
          min-width: 0;
          position: relative;
        }

        .timeline-rows {
          display: grid;
          gap: 6px;
        }

        .timeline {
          background: var(--dtek-track-background);
          border-radius: 4px;
          height: 26px;
          overflow: hidden;
          position: relative;
        }

        .slots {
          display: grid;
          grid-template-columns: repeat(48, minmax(0, 1fr));
          height: 100%;
          position: relative;
          z-index: 1;
        }

        .slot {
          border: 0;
          box-sizing: border-box;
          min-width: 0;
          position: relative;
        }

        .now-marker {
          background: var(--primary-color);
          bottom: 0;
          position: absolute;
          top: 0;
          width: 2px;
          z-index: 4;
        }

        .day-head {
          align-items: baseline;
          display: flex;
          font-size: var(--ha-font-size-s, 0.875rem);
          justify-content: space-between;
          margin-bottom: var(--ha-space-2, 8px);
        }

        .day-toggle {
          align-items: center;
          appearance: none;
          background: transparent;
          border: 0;
          color: var(--primary-text-color);
          cursor: pointer;
          display: inline-flex;
          font: inherit;
          font-weight: var(--ha-font-weight-medium, 500);
          gap: 3px;
          margin: -6px 0;
          min-height: 32px;
          min-width: 0;
          padding: 0;
          text-align: left;
        }

        .day-toggle .expand-icon {
          flex: 0 0 auto;
        }

        .day-agenda {
          display: none;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin: -2px 0 10px;
        }

        .timeline-day.expanded .day-agenda {
          display: grid;
        }

        .agenda-event {
          align-items: center;
          display: grid;
          gap: var(--ha-space-2, 8px);
          grid-template-columns: 6px minmax(0, 1fr) auto;
          min-height: 42px;
        }

        .agenda-event:nth-child(even) {
          padding-left: 18px;
        }

        .agenda-event strong {
          color: var(--primary-text-color);
          font-size: var(--ha-font-size-s, 0.875rem);
          font-weight: var(--ha-font-weight-medium, 500);
        }

        .agenda-event > span:last-child {
          color: var(--secondary-text-color);
          font-size: var(--ha-font-size-s, 0.875rem);
        }

        .agenda-mark {
          background: var(--dtek-outage-track);
          border-radius: 3px;
          height: 24px;
          width: 4px;
        }

        .agenda-mark.shutdown {
          background: var(--dtek-warning-track);
        }

        .agenda-mark.overlap {
          background: linear-gradient(
            to bottom,
            var(--dtek-outage-track) 0 50%,
            var(--dtek-warning-track) 50% 100%
          );
        }

        .slot.hour-start:not(:first-child) {
          border-left: 1px solid var(--dtek-hour-divider);
        }

        .slot.half-start::after {
          background: var(--dtek-half-tick-neutral);
          bottom: 0;
          content: "";
          height: 4px;
          left: -1px;
          position: absolute;
          width: 2px;
          z-index: 2;
        }

        .slot.outage {
          background: var(--dtek-outage-track);
        }

        .slot.half-start:is(.outage, .shutdown)::after {
          background: var(--dtek-half-tick-outage);
        }

        .slot.shutdown {
          background: var(--dtek-warning-track);
        }

        .slot.outage.shutdown {
          background: linear-gradient(
            to bottom,
            var(--dtek-outage-track) 0 50%,
            var(--dtek-warning-track) 50% 100%
          );
        }

        .hour-cells {
          align-items: center;
          color: var(--dtek-track-label);
          display: grid;
          font-size: var(--ha-font-size-s, 0.875rem);
          font-variant-numeric: tabular-nums;
          grid-template-columns: repeat(24, minmax(0, 1fr));
          inset: 0;
          line-height: 1;
          pointer-events: none;
          position: absolute;
          z-index: 5;
        }

        .hour-cells span {
          min-width: 0;
          text-align: center;
        }

        .timeline-half .slots {
          grid-template-columns: repeat(24, minmax(0, 1fr));
        }

        .timeline-half .hour-cells {
          grid-template-columns: repeat(12, minmax(0, 1fr));
        }

        .metadata {
          border-top: 1px solid var(--divider-color);
          color: var(--secondary-text-color);
          display: flex;
          font-size: var(--ha-font-size-s, 0.875rem);
          gap: var(--ha-space-3, 12px);
          justify-content: space-between;
          padding-top: 12px;
        }

        .metadata span {
          min-width: 0;
        }

        .footer-relative {
          color: inherit;
        }

        @container (max-width: 449px) {
          .statuses {
            grid-template-columns: 1fr;
          }

          .status {
            padding: 8px 0;
          }

          .statuses:not(.single) .status:first-child {
            padding-bottom: 10px;
          }

          .status + .status {
            border-left: 0;
            border-top: 1px solid var(--divider-color);
            padding-left: 0;
            padding-top: 10px;
          }

          .statuses .status:last-child {
            padding-bottom: 0;
          }

          .metadata {
            flex-direction: column;
            gap: 4px;
          }
        }

      </style>

      <div class="heading-host">
        <div class="heading-card-host"></div>
        ${group !== undefined && group !== null && group !== "" ? `
          <div class="group-label" aria-label="${escapeHtml(`${this._translate("group")} ${group}`)}">
            ${this.config.group_icon ? `<ha-icon icon="${escapeHtml(this.config.group_icon)}"></ha-icon>` : ""}
            <span>${escapeHtml(group)}</span>
          </div>
        ` : ""}
      </div>
      <ha-card>
        <div class="content">
          ${!hasOutageContent ? `
            <div class="empty-state">
              <ha-icon icon="mdi:check-circle-outline"></ha-icon>
              <span>${escapeHtml(noOutagesText)}</span>
            </div>
          ` : ""}

          ${statusCount ? `
            <div class="statuses${statusCount === 1 ? " single" : ""}">
              ${nextOutage ? this._renderStatus("next_outage", "mdi:power-plug-off", nextOutage) : ""}
              ${nextConnectivity ? this._renderStatus("next_connectivity", "mdi:power-plug", nextConnectivity) : ""}
            </div>
          ` : ""}

          ${shutdown?.reason || standaloneShutdownSegments.length ? `
            <div class="shutdown">
              ${shutdown?.reason ? `
                <div class="shutdown-heading">
                  <ha-icon class="shutdown-icon" icon="mdi:alert-outline"></ha-icon>
                  <div class="shutdown-reason">${escapeHtml(shutdown.reason)}</div>
                </div>
              ` : ""}
              ${standaloneShutdownSegments.length ? `<div class="shutdown-timeline">
                ${standaloneShutdownSegments.map((segment) => {
                  const relativeLabel = segment.dayKey === days.today
                    ? this._translate("today")
                    : segment.dayKey === days.tomorrow
                      ? this._translate("tomorrow")
                      : null;
                  return this._renderTimelineDay(
                    segment.dayKey,
                    [],
                    [segment],
                    segment.dayKey === days.today,
                    relativeLabel,
                    "shutdown",
                  );
                }).join("")}
              </div>` : ""}
            </div>
          ` : ""}

          ${hasTimelineContent ? `<div class="timeline-section">
            ${todaySegments.length || todayShutdownSegments.length
              ? this._renderTimelineDay(
                days.today,
                todaySegments,
                todayShutdownSegments,
                true,
                this._translate("today"),
              )
              : ""}
            ${tomorrowSegments.length || tomorrowShutdownSegments.length
              ? this._renderTimelineDay(
                days.tomorrow,
                tomorrowSegments,
                tomorrowShutdownSegments,
                false,
                this._translate("tomorrow"),
              )
              : ""}
          </div>` : ""}

          ${sensorAvailable && metadataCount ? `
            <div class="metadata">
              ${dtekChanged ? `<span>${escapeHtml(this._translate("schedule_updated"))} · ${escapeHtml(this._formatChangedTime(dtekChanged))}</span>` : ""}
              ${checkedAt ? `<span>${escapeHtml(this._translate("last_checked"))} · ${this._relativeInlineMarkup(checkedAt)}</span>` : ""}
            </div>
          ` : ""}
        </div>
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll("ha-relative-time[data-datetime]").forEach((element) => {
      element.datetime = element.dataset.datetime;
      element.capitalize = element.dataset.capitalize === "true";
      element.hass = this._hass;
    });
    this._bindInteractions();
    const headingHost = this.shadowRoot.querySelector(".heading-card-host");
    if (reusableHeading && headingHost) {
      reusableHeading.hass = this._headingHass();
      headingHost.replaceChildren(reusableHeading);
      this._headingCard = reusableHeading;
    } else {
      this._mountHeading(headingHost, headingRender);
    }
  }
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, DtekOutageCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "DTEK outage schedule",
    description: "Compact DTEK outage status and two-day timeline",
    preview: true,
  });
}
