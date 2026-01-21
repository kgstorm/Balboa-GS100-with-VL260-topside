/*
Spa Control Card — a polished Lovelace custom card with in-editor schema and built-in actions.

Install:
1. Copy this file to your config/www/ directory (e.g., /config/www/spa-control-card.js)
2. Add the resource (Configuration → Lovelace Dashboards → Resources):
   - URL: /local/spa-control-card.js
   - Type: module
3. Add the card using the UI "Add Card" and search for "Spa Control Card" (the editor will prompt for values), or use raw YAML:

type: 'custom:spa-control-card'
esp_device: 'esp32-spa'  # recommended
hot_temp: 103
cold_temp: 98

Notes:
- The editor supports explicit entity names for each entity (if automatic detection fails for your installation).
- If scripts exist (e.g., script.spa_set_hot), the card will attempt to call them for Set Hot/Cold. Otherwise it will press the warm/cool button repeatedly until the set temp matches or a safety limit is reached.
- This card attempts to infer entity IDs from the `esp_device` config by trying a few common patterns. If you see warnings in the UI, fill in the explicit entity id fields in the editor.

*/

class SpaControlCard extends HTMLElement {
  setConfig(config) {
    // Copy the config into a mutable object — Home Assistant may pass an immutable/frozen object
    this.config = Object.assign({}, config || {});

    // Device name (required); if missing, show inline message rather than throwing so UI remains stable
    const device = this.config.device_name || this.config.esp_device || this.config.device;
    if (!device) {
      this._showConfigMessage('Missing `device_name` in card config');
      return;
    }
    this._device_norm = this._normalizeDeviceName(device);

    if (!this._container) {
      this._container = document.createElement('div');
      this._container.style.padding = '0';
      this._container.style.fontFamily = 'var(--paper-font-body1_-_font-family)';
      this._container.innerHTML = `
        <ha-card>
          <style>
            .spa-left { position: absolute; left: 0px; top: 18px; height: auto; width: 140px; display:flex; flex-direction:column; justify-content:flex-start; gap:5px; padding:6px 0; box-sizing:border-box; overflow:visible }
            .spa-right { position: absolute; right: 0px; top: 18px; height: auto; width: 140px; display:flex; flex-direction:column; justify-content:flex-start; gap:5px; padding:6px 0; box-sizing:border-box; overflow:visible }

            /* defined side buttons that visually form a panel around the circle */
            .side-button { position:relative; z-index:2; width:84px; height:44px; border-radius:6px; border:2px solid rgba(0,0,0,0.28); background:linear-gradient(var(--side-button-bg-start,#ffffff),var(--side-button-bg-end,#efefef)); color:var(--primary-text-color,#000); display:flex; align-items:center; justify-content:center; box-shadow:0 8px 18px rgba(0,0,0,0.10); transition: transform .12s ease, box-shadow .12s ease; font-weight:700; font-size:14px; text-align:center; padding:6px; overflow:visible }
            .side-button.left { padding-right:10px; }
            .side-button.right { padding-left:10px; }
            .side-button:hover { transform: translateX(6px); box-shadow:0 14px 28px rgba(0,0,0,0.14); }
            .side-button.right:hover { transform: translateX(-6px); }
            .side-button ha-icon { color: inherit; }

            /* Dark mode styles */
            @media (prefers-color-scheme: dark) {
              .side-button { border-color: rgba(255,255,255,0.06); background: linear-gradient(#2a2a2a,#1d1d1d); box-shadow: 0 6px 14px rgba(0,0,0,0.6); color: var(--primary-text-color,#fff); }
              .side-button:hover { box-shadow: 0 10px 20px rgba(0,0,0,0.6); }
            }

            /* mask uses CSS variables so it can be positioned so the arc is concentric with the display circle */
            .side-button::after { display: none; }

            .side-bar { width:8px;height:64px;border-radius:6px;background:rgba(0,0,0,0.06); }
            /* slight bevel to blend with circle */
            .circle { background:linear-gradient(#ffffff,#fafafa); box-shadow: inset 0 0 0 6px var(--primary-color, #03A9F4); z-index:6; position:relative }

            /* optional card title */
            .card-title { font-size:18px; font-weight:600; margin-bottom:8px; text-align:center; color:var(--primary-text-color); }

            ha-card, #big { overflow: visible }
          </style>
          <div style="display:flex;align-items:center;justify-content:center;padding:18px">
            <div id="big" style="display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div id="card_title" class="card-title" style="display:none"></div>
              <div class="circle" style="width:260px;height:260px;border-radius:50%;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--paper-card-background-color);box-shadow: inset 0 0 0 6px var(--primary-color, #03A9F4);">                <div class="meas" style="font-size:60px;font-weight:700">—</div>
                <div class="set-row" style="margin-top:12px;font-size:18px;color:var(--secondary-text-color)"><span class="set-label">Set</span>: <span class="set">—</span></div>
                <div id="config_msg" style="margin-top:6px;font-size:12px;color:var(--error-color)"></div>

                <div class="inner-sensors" style="position:absolute;left:50%;bottom:18px;transform:translateX(-50%);width:48%;display:flex;justify-content:space-between;align-items:flex-end;pointer-events:auto">
                  <div class="sensor heater" role="img" aria-label="Heater" style="display:flex;align-items:center;justify-content:center;">
                    <ha-icon id="heater_icon" icon="mdi:fire" style="width:32px;height:32px;color:var(--disabled-text-color,#bdbdbd);transform:translateY(-8px);transition:transform .18s ease,filter .18s ease,color .18s ease"></ha-icon>
                  </div>
                  <div class="sensor pump" role="img" aria-label="Pump" style="display:flex;align-items:center;justify-content:center;">
                    <ha-icon id="pump_icon" icon="mdi:fan" style="width:34px;height:34px;color:var(--disabled-text-color,#bdbdbd);transform:translateY(12px);transition:transform .18s ease,filter .18s ease,color .18s ease"></ha-icon>
                  </div>
                  <div class="sensor lights" role="img" aria-label="Lights" style="display:flex;align-items:center;justify-content:center;">
                    <ha-icon id="lights_icon" icon="mdi:string-lights" style="width:32px;height:32px;color:var(--disabled-text-color,#bdbdbd);transform:translateY(-8px);transition:transform .18s ease,filter .18s ease,color .18s ease"></ha-icon>
                  </div>
                </div>

                
                <!-- Left side stack: Set Low (top), Temp Down (middle), Lights (bottom) -->
                <div class="spa-left">

                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:0 0 10px"></div>
                    <button id="set_low_btn" class="side-button left" title="Set Low">Set Low</button>
                  </div>

                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:0 0 10px"></div>
                    <button id="temp_down_btn" class="side-button left" title="Temp Down"><ha-icon icon="mdi:chevron-down" style="vertical-align:middle"></ha-icon></button>
                  </div>

                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:0 0 10px"></div>
                    <button id="lights_btn" class="side-button left" title="Lights"><ha-icon icon="mdi:lightbulb" style="vertical-align:middle"></ha-icon></button>
                  </div>

                </div>

                <!-- Right side stack: Set High (top), Temp Up (middle), Pump (bottom) -->
                <div class="spa-right">

                  <div style="display:flex;align-items:center;gap:8px">
                    <button id="set_high_btn" class="side-button right" title="Set High">Set High</button>
                    <div style="flex:0 0 10px"></div>
                  </div>

                  <div style="display:flex;align-items:center;gap:8px">
                    <button id="temp_up_btn" class="side-button right" title="Temp Up"><ha-icon icon="mdi:chevron-up" style="vertical-align:middle"></ha-icon></button>
                    <div style="flex:0 0 10px"></div>
                  </div>

                  <div style="display:flex;align-items:center;gap:8px">
                    <button id="pump_btn" class="side-button right" title="Pump"><ha-icon icon="mdi:fan" style="vertical-align:middle"></ha-icon></button>
                    <div style="flex:0 0 10px"></div>
                  </div>

                </div>

              </div>
            </div>
          </div>
        </ha-card>
      `;
      this.appendChild(this._container);
      // remove any leftover debug overlays from previous versions
      const oldDbg = this.querySelector('#big .dbg-panel');
      if (oldDbg && oldDbg.parentNode) oldDbg.parentNode.removeChild(oldDbg);
      const gOld = document.body.querySelector('.dbg-global');
      if (gOld && gOld.parentNode) gOld.parentNode.removeChild(gOld);
      // debug disabled by default
      this._debug = false;
    }

    // optional label override for set prefix
    const setLabel = this.config.set_label || 'Set';
    const setLabelEl = this.querySelector('#big .set-label');
    if (setLabelEl) setLabelEl.textContent = setLabel;

    // optional title (show only when provided)
    const titleText = this.config.title || '';
    const titleEl = this.querySelector('#card_title');
    if (titleEl) { titleEl.textContent = titleText; titleEl.style.display = titleText ? 'block' : 'none'; }

    // Assign deterministic entity IDs based on device name (no guessing)
    // User specified: set entity = sensor.${device}_spa_set_temp
    if (!this.config.set_entity) this.config.set_entity = `sensor.${this._device_norm}_spa_set_temp`;
    if (!this.config.measured_entity) this.config.measured_entity = `sensor.${this._device_norm}_spa_measured_temp`;

    // sensible defaults for heater, pump and lights status sensors (binary_sensor states)
    // These use the device naming convention used by the ESP device firmware
    if (!this.config.heater_entity) this.config.heater_entity = `binary_sensor.${this._device_norm}_spa_heater_status`;
    if (!this.config.pump_entity) this.config.pump_entity = `binary_sensor.${this._device_norm}_spa_pump_status`;
    if (!this.config.light_entity) this.config.light_entity = `binary_sensor.${this._device_norm}_spa_light_status`;

    // sensible defaults for temp buttons (warm/cool)
    if (!this.config.temp_up_entity) this.config.temp_up_entity = `button.${this._device_norm}_spa_warm`;
    if (!this.config.temp_down_entity) this.config.temp_down_entity = `button.${this._device_norm}_spa_cool`;

    // sensible defaults for pump and lights control buttons
    if (!this.config.pump_button_entity) this.config.pump_button_entity = `button.${this._device_norm}_spa_pumps`;
    if (!this.config.lights_button_entity) this.config.lights_button_entity = `button.${this._device_norm}_spa_lights`;

    // initial update
    this._update();

    // hook up control buttons (idempotent) and hide optional set buttons
    const setupBtn = (sel, handler) => {
      const el = this.querySelector(sel);
      if (!el) return;
      if (!el.__hasClick) {
        el.addEventListener('click', handler.bind(this));
        el.__hasClick = true;
      }
    };

    setupBtn('#temp_up_btn', this._onTempUp);
    setupBtn('#temp_down_btn', this._onTempDown);
    setupBtn('#set_high_btn', this._onSetHigh);
    setupBtn('#set_low_btn', this._onSetLow);
    setupBtn('#pump_btn', this._onPump);
    setupBtn('#lights_btn', this._onLights);

    const setHighEl = this.querySelector('#set_high_btn');
    const setLowEl = this.querySelector('#set_low_btn');
    if (setHighEl) setHighEl.style.display = (typeof this.config.high_setting !== 'undefined') ? 'flex' : 'none';
    if (setLowEl) setLowEl.style.display = (typeof this.config.low_setting !== 'undefined') ? 'flex' : 'none';

    // position the inner cutouts so each button edge is concentric with the display circle
    this._updateCutouts();
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    this._resizeHandler = this._updateCutouts.bind(this);
    window.addEventListener('resize', this._resizeHandler);

    // watch for text/size changes (e.g., measured temp updating) and re-run the cutout sync
    if (this._mutObs) this._mutObs.disconnect();
    this._mutObs = new MutationObserver(() => this._updateCutouts());
    const measEl = this.querySelector('#big .meas');
    const setEl = this.querySelector('#big .set');
    // observe the card container as a fallback if individual elements aren't present
    const target = measEl || setEl || this._container;
    this._mutObs.observe(target, { subtree: true, childList: true, characterData: true });
  }

  set hass(hass) {
    this._hass = hass;
    // update and show debug info
    this._update();
  }

  _update() {
    if (!this._hass || !this.config || !this._container) return;

    const getState = id => id && this._hass.states && this._hass.states[id] ? this._hass.states[id] : null;
    const measState = getState(this.config.measured_entity);
    const setState = getState(this.config.set_entity);

    const fmt = s => {
      if (!s || s.state === 'unknown' || s.state === 'unavailable') return '—';
      const n = Number(s.state);
      if (!Number.isFinite(n)) return String(s.state);
      const unit = s.attributes && s.attributes.unit_of_measurement ? s.attributes.unit_of_measurement : '';
      return `${Math.round(n * 10) / 10}${unit}`;
    };

    const measSpan = this.querySelector('#big .meas');
    const setSpan = this.querySelector('#big .set');
    if (measSpan) measSpan.textContent = fmt(measState);
    if (setSpan) setSpan.textContent = fmt(setState);

    // heater / pump / lights: show simple on/off state and subtle glow when active
    const heaterState = getState(this.config.heater_entity);
    const pumpState = getState(this.config.pump_entity);
    const lightsState = getState(this.config.light_entity);

    const heaterIcon = this.querySelector('#heater_icon');
    const pumpIcon = this.querySelector('#pump_icon');
    const lightsIcon = this.querySelector('#lights_icon');

    const offColor = 'var(--disabled-text-color,#bdbdbd)';

    if (heaterIcon) {
      const isOn = heaterState && heaterState.state === 'on';
      heaterIcon.style.color = isOn ? '#ff7043' : offColor; // orange when heating
      heaterIcon.style.filter = isOn ? 'drop-shadow(0 0 8px rgba(255,112,67,0.9))' : 'none';
    }

    if (pumpIcon) {
      const isOn = pumpState && pumpState.state === 'on';
      pumpIcon.style.color = isOn ? '#03a9f4' : offColor; // bright blue when running
      pumpIcon.style.filter = isOn ? 'drop-shadow(0 0 8px rgba(3,169,244,0.9))' : 'none';
    }

    if (lightsIcon) {
      const isOn = lightsState && lightsState.state === 'on';
      // default is a binary_sensor for light status — simple on/off styling
      lightsIcon.style.color = isOn ? '#ffd54f' : offColor; // warm yellow when on
      lightsIcon.style.filter = isOn ? 'drop-shadow(0 0 10px rgba(255,213,79,0.9))' : 'none';
    }

    // reflect busy state in controls (disable while adjusting set points)
    const controlBlocks = this.querySelectorAll('.side-left, .side-right');
    if (controlBlocks && controlBlocks.length) {
      controlBlocks.forEach(c => {
        c.style.pointerEvents = this._busy ? 'none' : 'auto';
        c.style.opacity = this._busy ? '0.6' : '1';
      });
      const roundBtns = this.querySelectorAll('#temp_up_btn,#temp_down_btn');
      roundBtns.forEach(b => b && (b.style.filter = this._busy ? 'grayscale(0.6) opacity(0.8)' : 'none'));
    }

    // keep the masks in sync (e.g. when text changes/size changes)
    this._updateCutouts();
  }

  _normalizeDeviceName(name) {
    // normalize by replacing non-alphanum with underscore, collapses multiple underscores
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  _showConfigMessage(msg) {
    // show a non-fatal config message inside the card so the editor doesn't break
    if (!this._container) return;
    const el = this.querySelector('#big #config_msg');
    if (el) el.textContent = msg;
    // also output to console for easy debugging
    console.warn('spa-control-card config:', msg);
  }

  disconnectedCallback() {
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this._mutObs) this._mutObs.disconnect();
  }

  // keep side button inner masks concentric with the main circle
  _updateCutouts() {
    // Keep buttons in normal flow and compute clip-path tangents relative to the circle
    window.requestAnimationFrame(() => {
      setTimeout(() => {
        const circle = this.querySelector('.circle');
        if (!circle) return;
        const circleRect = circle.getBoundingClientRect();
        const gap = 5; // spacing between buttons
        const buttonCount = 3; // number of buttons per side
        const radius = circleRect.width / 2;
        const centerX = circleRect.left + radius;
        const centerY = circleRect.top + circleRect.height / 2;

        // Ensure side container spacing matches the requirement and position them relative to card edges
        const sideContainers = this.querySelectorAll('.spa-left, .spa-right');
        const big = this.querySelector('#big');
        const bigRect = big ? big.getBoundingClientRect() : { left: 0, top: 0 };
        const haCard = this.querySelector('ha-card');
        const haRect = haCard ? haCard.getBoundingClientRect() : bigRect;
        sideContainers.forEach(c => {
          c.style.display = 'flex';
          c.style.flexDirection = 'column';
          c.style.gap = `${gap}px`;

          // compute horizontal offset so outer edge is 5px from card edge
          let containerWidth = Math.round((c.getBoundingClientRect && c.getBoundingClientRect().width) || c.offsetWidth || 140);
          const sideName = c.classList.contains('spa-left') ? 'left' : 'right';

          if (c.classList.contains('spa-left')) {
            // place container so its LEFT edge sits 5px inside the left edge of the card (i.e. card.left + 5)
            const desiredLeftRel = Math.round(haRect.left - circleRect.left + 5);
            const leftPos = Math.round(desiredLeftRel);
            c.style.left = `${leftPos}px`;
            c.style.right = 'auto';
          } else {
            // place container so its RIGHT edge sits 5px to the LEFT of the right edge of the card (i.e. card.right - 5)
            const desiredRightRel = Math.round(haRect.right - circleRect.left - 5);
            // attempt to move container to the right of the circle with a gap; if it doesn't fit, shrink container width
            let leftPos = Math.round(desiredRightRel - containerWidth);
            c.style.left = `${leftPos}px`;
            c.style.right = 'auto';

            // compute absolute coords
            let absLeft = Math.round(circleRect.left + leftPos);
            let absRight = absLeft + containerWidth;
            const expectedRightAbs = haRect.right - 5;

            // space available between circle right and card right
            const availableSpace = Math.round(haRect.right - (circleRect.left + circleRect.width));
            const desiredMarginFromCircle = 16; // px gap from circle right edge (bigger per request)
            const minContainerWidth = 100; // ensure buttons still fit (button=84 + padding)

            if (containerWidth > (availableSpace - desiredMarginFromCircle)) {
              // shrink container to fit the available space while keeping at least minContainerWidth
              const newContainerWidth = Math.max(minContainerWidth, availableSpace - desiredMarginFromCircle);
              if (newContainerWidth < containerWidth) {
                c.style.width = `${newContainerWidth}px`;
                // shrink child button widths to fit (give them a small padding)
                Array.from(c.querySelectorAll('.side-button')).forEach(b => {
                  b.style.width = `${Math.max(84, newContainerWidth - 16)}px`;
                });
                containerWidth = newContainerWidth;
                // recompute positions
                leftPos = Math.round(desiredRightRel - containerWidth);
                absLeft = Math.round(circleRect.left + leftPos);
                absRight = absLeft + containerWidth;
              }
            }

            // After possible shrinking, ensure it is at or to the right of circle + margin and inside card
            const minAbsLeft = Math.round(circleRect.left + circleRect.width + desiredMarginFromCircle);
            const maxAbsLeft = Math.round(haRect.right - 5 - containerWidth);

            if (absLeft < minAbsLeft) {
              absLeft = minAbsLeft;
              leftPos = absLeft - circleRect.left;
            }
            if (absLeft > maxAbsLeft) {
              absLeft = maxAbsLeft;
              leftPos = absLeft - circleRect.left;
            }

            // apply changes
            c.style.left = `${leftPos}px`;
            absRight = absLeft + containerWidth;
          }

          // compute vertical placement so the button stack is centered within the circle
          const buttons = Array.from(c.querySelectorAll('.side-button'));
          const numButtons = buttons.length || 3;
          // measure an individual button height (use offsetHeight or fallback to 44)
          const sampleBtn = buttons[0];
          const btnH = sampleBtn ? (sampleBtn.getBoundingClientRect().height || sampleBtn.offsetHeight) : 44;
          const stackGap = gap; // gap between buttons
          const stackHeight = Math.round(numButtons * btnH + (numButtons - 1) * stackGap);

          // compute top inside the circle (circle is the positioned ancestor)
          let topPx = Math.round((circleRect.height - stackHeight) / 2);
          // ensure some minimal padding
          if (topPx < 6) topPx = 6;

          c.style.top = `${topPx}px`;
          // keep container height to circle height so it stays inside
          c.style.height = `${Math.round(circleRect.height)}px`;
        });
        

        // Remove complex clipping — use simple rectangular buttons with slight rounding and thicker borders
        const sideButtons = this.querySelectorAll('.spa-left .side-button, .spa-right .side-button');
        sideButtons.forEach(btn => {
          btn.style.clipPath = 'none';
          btn.style.borderRadius = '6px';
          btn.style.margin = '0';
        });

      }, 0);
    });
  }

  // Note: removed fuzzy/auto inference functions — entities are mapped deterministically now

  // Helpers for button interactions and target-setting behavior
  _getNumericState(stateObj) {
    if (!stateObj || stateObj.state === 'unknown' || stateObj.state === 'unavailable') return null;
    const n = Number(stateObj.state);
    return Number.isFinite(n) ? n : null;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _pressButtonNTimes(entityId, times, delayMs = 300) {
    for (let i = 0; i < times; i++) {
      try {
        await this._hass.callService('button', 'press', { entity_id: entityId });
      } catch (e) {
        console.warn('spa-control-card: press failed', entityId, e);
      }
      await this._sleep(delayMs);
    }
  }

  async _setToTarget(target) {
    if (this._busy) return;
    this._busy = true;
    this._update();
    const maxAttempts = 6;
    const pressDelay = 280;
    const verifyDelay = 500;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cur = this._getNumericState(this._hass.states[this.config.set_entity]);
        if (cur === null) break;
        const diff = Math.round(target - cur);
        if (diff === 0) return;
        const times = Math.abs(diff);
        const entityToPress = diff > 0 ? this.config.temp_up_entity : this.config.temp_down_entity;
        await this._pressButtonNTimes(entityToPress, times, pressDelay);
        await this._sleep(verifyDelay);
      }
      // final verification
      const final = this._getNumericState(this._hass.states[this.config.set_entity]);
      if (final === null || Math.round(final) !== Math.round(target)) {
        this._showConfigMessage('Unable to reach desired set temperature');
      }
    } finally {
      this._busy = false;
      this._update();
    }
  }

  async _onSetHigh() {
    if (!this.config || typeof this.config.high_setting === 'undefined') return;
    const target = Number(this.config.high_setting);
    if (!Number.isFinite(target)) { this._showConfigMessage('Invalid high_setting'); return; }
    await this._setToTarget(target);
  }

  async _onSetLow() {
    if (!this.config || typeof this.config.low_setting === 'undefined') return;
    const target = Number(this.config.low_setting);
    if (!Number.isFinite(target)) { this._showConfigMessage('Invalid low_setting'); return; }
    await this._setToTarget(target);
  }

  async _onTempUp() {
    if (this._busy) return;
    this._busy = true;
    this._update();
    try { await this._hass.callService('button', 'press', { entity_id: this.config.temp_up_entity }); } catch (e) { console.warn(e); }
    this._busy = false;
    this._update();
  }

  async _onTempDown() {
    if (this._busy) return;
    this._busy = true;
    this._update();
    try { await this._hass.callService('button', 'press', { entity_id: this.config.temp_down_entity }); } catch (e) { console.warn(e); }
    this._busy = false;
    this._update();
  }

  async _onPump() {
    if (this._busy) return;
    this._busy = true;
    this._update();
    try { await this._hass.callService('button', 'press', { entity_id: this.config.pump_button_entity }); } catch (e) { console.warn(e); }
    this._busy = false;
    this._update();
  }

  async _onLights() {
    if (this._busy) return;
    this._busy = true;
    this._update();
    try { await this._hass.callService('button', 'press', { entity_id: this.config.lights_button_entity }); } catch (e) { console.warn(e); }
    this._busy = false;
    this._update();
  }

  getCardSize() {
    return 3;
  }
}

if (!customElements.get('spa-control-card')) {
  customElements.define('spa-control-card', SpaControlCard);
} else {
  console.warn('spa-control-card already defined; skipping re-definition');
}

// Make it show up in the "Add Card" UI
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'spa-control-card',
  name: 'Spa Control Card',
  description: 'Control Spa: set temps, lights, pumps, and view status',
  preview: true,
  documentationURL: 'https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/'
});