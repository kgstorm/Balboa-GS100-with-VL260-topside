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
            /* Outer wrapper enables CSS container queries scoped to actual card width */
            #spa-card-outer { container-type: inline-size; container-name: spa-card; }

            /* Flex row: [spa-left] [circle] [spa-right] — no overflow required */
            #spa-row { display:flex; flex-direction:row; align-items:center; justify-content:center; gap:10px; width:100%; }

            /* Side panels as normal flex column items */
            .spa-left, .spa-right { display:flex; flex-direction:column; gap:6px; box-sizing:border-box; width:84px; flex-shrink:0; align-items:stretch; justify-content:center; }

            /* Side buttons */
            .side-button { width:100%; box-sizing:border-box; height:44px; border-radius:6px; border:2px solid rgba(0,0,0,0.15); background:var(--card-background-color,#fff); color:var(--primary-text-color,#000); display:flex; align-items:center; justify-content:center; box-shadow:0 4px 10px rgba(0,0,0,0.10); transition: transform .12s ease, box-shadow .12s ease; font-weight:700; font-size:13px; padding:4px; cursor:pointer; }
            @media (hover: hover) and (pointer: fine) {
              .spa-left .side-button:hover { transform: translateX(3px); box-shadow:0 8px 20px rgba(0,0,0,0.14); }
              .spa-right .side-button:hover { transform: translateX(-3px); box-shadow:0 8px 20px rgba(0,0,0,0.14); }
            }
            .side-button.tap { transform: scale(0.95) !important; box-shadow:0 2px 6px rgba(0,0,0,0.10) !important; transition: transform .08s ease !important; }
            .side-button ha-icon { color: inherit; pointer-events:none; }

            /* Circle */
            .circle { --circle-size: 220px; position:relative; width:var(--circle-size); height:var(--circle-size); border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--ha-card-background,var(--paper-card-background-color,var(--card-background-color,#121212))); box-shadow: inset 0 0 0 6px var(--primary-color, #03A9F4); flex-shrink:0; }

            /* Mode label inside circle */
            #mode-label { font-size:13px; font-weight:600; letter-spacing:0.06em; color:var(--primary-color,#03A9F4); text-transform:uppercase; height:16px; line-height:16px; margin-bottom:2px; opacity:1; transition:opacity .2s; transform:translateY(9px); }
            #mode-label:empty { opacity:0; }
            .circle .meas { transform:translateY(9px); }
            #temp-group { display:flex; flex-direction:column; align-items:center; transform:translateY(-11px); }

            /* Mode strip below the main row */
            #mode-strip { display:flex; flex-direction:row; gap:8px; width:100%; margin-top:12px; box-sizing:border-box; }
            .mode-button { flex:1; height:40px; border-radius:8px; border:2px solid rgba(0,0,0,0.15); background:var(--card-background-color,#fff); color:var(--primary-text-color,#000); font-weight:600; font-size:14px; cursor:pointer; transition: background .18s, color .18s, border-color .18s, box-shadow .18s; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
            .mode-button.tap { transform: scale(0.96) !important; transition: transform .08s ease !important; }

            /* Container queries — respond to actual card width, not viewport width */
            @container spa-card (max-width: 420px) {
              .spa-left, .spa-right { width:70px; gap:5px; }
              #spa-row { gap:6px; }
              .circle { --circle-size: 196px; }
              .circle .meas { font-size:46px !important; transform:translateY(0); }
              .set-row { font-size:14px !important; margin-top:-8px !important; }
              #temp-group { transform:translateY(-6px); }
              #mode-label { transform:translateY(0); }
              .side-button { height:38px; font-size:12px; }
              .mode-button { height:36px; font-size:13px; }
            }
            @container spa-card (max-width: 340px) {
              .spa-left, .spa-right { width:58px; gap:4px; }
              #spa-row { gap:5px; }
              .circle { --circle-size: 166px; }
              .circle .meas { font-size:34px !important; transform:translateY(0); }
              .set-row { font-size:12px !important; margin-top:-2px !important; }
              #temp-group { transform:translateY(-7px); }
              #mode-label { transform:translateY(0); }
              .side-button { height:32px; font-size:11px; }
              .inner-sensors ha-icon { width:22px !important; height:22px !important; }
              .inner-sensors { bottom:25px !important; width:58% !important; }
              .mode-button { height:30px; font-size:12px; }
            }

            /* Dark mode */
            @media (prefers-color-scheme: dark) {
              .side-button { border-color:rgba(255,255,255,0.10); background:linear-gradient(#2a2a2a,#1d1d1d); box-shadow:0 4px 10px rgba(0,0,0,0.5); color:var(--primary-text-color,#fff); }
              .mode-button { border-color:rgba(255,255,255,0.10); background:linear-gradient(#2a2a2a,#1d1d1d); color:var(--primary-text-color,#fff); }
            }

            /* Optional card title */
            .card-title { font-size:18px; font-weight:600; margin-bottom:10px; text-align:center; color:var(--primary-text-color); }
          </style>
          <div id="spa-card-outer" style="padding:14px 10px;box-sizing:border-box">
            <div id="big" style="display:flex;flex-direction:column;align-items:center">
              <div id="card_title" class="card-title" style="display:none"></div>
              <div id="spa-row">
                <!-- Left: Set Low, Temp Down, Lights -->
                <div class="spa-left">
                  <button id="set_low_btn" class="side-button" title="Set Low" style="display:none">Set Low</button>
                  <button id="temp_down_btn" class="side-button" title="Temp Down"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
                  <button id="lights_btn" class="side-button" title="Lights"><ha-icon icon="mdi:lightbulb"></ha-icon></button>
                </div>

                <!-- Circle -->
                <div class="circle">
                  <div id="temp-group">
                    <div id="mode-label"></div>
                    <div class="meas" style="font-size:60px;font-weight:700">—</div>
                    <div class="set-row" style="margin-top:0;font-size:18px;color:var(--secondary-text-color)"><span class="set-label">Set</span>: <span class="set">—</span></div>
                    <div id="config_msg" style="margin-top:6px;font-size:12px;color:var(--error-color)"></div>
                  </div>
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
                </div>

                <!-- Right: Set High, Temp Up, Pump -->
                <div class="spa-right">
                  <button id="set_high_btn" class="side-button" title="Set High" style="display:none">Set High</button>
                  <button id="temp_up_btn" class="side-button" title="Temp Up"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
                  <button id="pump_btn" class="side-button" title="Pump"><ha-icon icon="mdi:fan"></ha-icon></button>
                </div>
              </div>

              <!-- Mode strip: Eco / Standard / Sleep -->
              <div id="mode-strip">
                <button id="eco_btn" class="mode-button" title="Economy">Economy</button>
                <button id="standard_btn" class="mode-button" title="Standard">Standard</button>
                <button id="sleep_btn" class="mode-button" title="Sleep">Sleep</button>
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
    // User specified: set entity = sensor.${device}_set_temp
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

    // spa mode sensor (tracks current heating mode: eco / standard / sleep)
    if (!this.config.mode_entity) this.config.mode_entity = `sensor.${this._device_norm}_spa_mode`;

    // initial update
    this._update();

    // hook up control buttons (idempotent) and hide optional set buttons
    const setupBtn = (sel, handler) => {
      const el = this.querySelector(sel);
      if (!el) return;
      if (!el.__hasClick) {
        el.addEventListener('click', handler.bind(this));
        // transient pulse feedback for multiple clicks: briefly add 'pulse' class then remove
        el.addEventListener('click', () => {
          el.classList.add('tap');
          if (el.__tapTimeout) clearTimeout(el.__tapTimeout);
          el.__tapTimeout = setTimeout(() => el.classList.remove('tap'), 140);
        });
        el.__hasClick = true;
      }
    };

    setupBtn('#temp_up_btn', this._onTempUp);
    setupBtn('#temp_down_btn', this._onTempDown);
    setupBtn('#set_high_btn', this._onSetHigh);
    setupBtn('#set_low_btn', this._onSetLow);
    setupBtn('#pump_btn', this._onPump);
    setupBtn('#lights_btn', this._onLights);
    setupBtn('#eco_btn', this._onEco);
    setupBtn('#standard_btn', this._onStandard);
    setupBtn('#sleep_btn', this._onSleep);

    const setHighEl = this.querySelector('#set_high_btn');
    const setLowEl = this.querySelector('#set_low_btn');
    if (setHighEl) setHighEl.style.display = (typeof this.config.high_setting !== 'undefined') ? 'flex' : 'none';
    if (setLowEl) setLowEl.style.display = (typeof this.config.low_setting !== 'undefined') ? 'flex' : 'none';

    // show/hide mode strip based on config (default: visible)
    const modeStripEl = this.querySelector('#mode-strip');
    if (modeStripEl) modeStripEl.style.display = (this.config.show_mode_buttons !== false) ? 'flex' : 'none';

    // layout handled by CSS (no JS cutouts required).
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
      const unavailable = !pumpState || pumpState.state === 'unavailable';
      const pumpContainer = pumpIcon.closest('.sensor.pump');
      if (pumpContainer) pumpContainer.style.display = unavailable ? 'none' : 'flex';
      if (!unavailable) {
        const isOn = pumpState.state === 'on';
        pumpIcon.style.color = isOn ? '#03a9f4' : offColor; // bright blue when running
        pumpIcon.style.filter = isOn ? 'drop-shadow(0 0 8px rgba(3,169,244,0.9))' : 'none';
      }
    }

    if (lightsIcon) {
      const unavailable = !lightsState || lightsState.state === 'unavailable';
      const lightsContainer = lightsIcon.closest('.sensor.lights');
      if (lightsContainer) lightsContainer.style.display = unavailable ? 'none' : 'flex';
      if (!unavailable) {
        const isOn = lightsState.state === 'on';
        // default is a binary_sensor for light status — simple on/off styling
        lightsIcon.style.color = isOn ? '#ffd54f' : offColor; // warm yellow when on
        lightsIcon.style.filter = isOn ? 'drop-shadow(0 0 10px rgba(255,213,79,0.9))' : 'none';
      }
    }

    // Mode label inside circle — reflects current mode state
    const modeState = getState(this.config.mode_entity);
    const modeVal = modeState && modeState.state !== 'unknown' && modeState.state !== 'unavailable'
      ? modeState.state.toLowerCase() : '';
    const modeLabelEl = this.querySelector('#mode-label');
    if (modeLabelEl) {
      if (this._modeMatches(modeVal, 'eco')) modeLabelEl.textContent = 'Economy';
      else if (this._modeMatches(modeVal, 'sleep')) modeLabelEl.textContent = 'Sleep';
      else if (this._modeMatches(modeVal, 'standard')) modeLabelEl.textContent = 'Standard';
      else modeLabelEl.textContent = '';
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

    // layout now purely CSS-driven; nothing to run here
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
  }

  // Position side button stacks relative to the display circle
  /* Layout handled by CSS now. _updateCutouts retained as a no-op for backward compatibility. */
  _updateCutouts() { /* no-op; CSS handles positions */ }

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

  // Returns true if a mode state string matches the given target ('eco', 'standard', 'sleep')
  _modeMatches(stateStr, target) {
    if (target === 'eco')      return /economy|eco|^ec$/.test(stateStr);
    if (target === 'standard') return /std|standard|^st$/.test(stateStr);
    if (target === 'sleep')    return /sleep|^sl$|slp/.test(stateStr);
    return false;
  }

  // Set heating mode by pressing Warm then cycling Light until the target mode appears.
  // Cycle order (manufacturer confirmed): St -> Ec -> SL -> St
  async _setToMode(targetMode) {
    if (this._busy) return;
    this._busy = true;
    this._update();
    try {
      // Each attempt: press Warm, wait 500ms, press Light, wait 1000ms, check mode
      for (let i = 0; i < 8; i++) {
        await this._hass.callService('button', 'press', { entity_id: this.config.temp_up_entity });
        await this._sleep(500);
        await this._hass.callService('button', 'press', { entity_id: this.config.lights_button_entity });
        await this._sleep(1000); // allow firmware to detect stable mode code and HA to propagate
        const ms = this._hass.states[this.config.mode_entity];
        if (ms && this._modeMatches(ms.state.toLowerCase(), targetMode)) break;
        if (i === 7) this._showConfigMessage('Could not set mode — check spa display');
      }
    } catch (e) { console.warn('spa-control-card: _setToMode failed', e); }
    this._busy = false;
    this._update();
  }

  async _onEco()      { await this._setToMode('eco'); }
  async _onStandard() { await this._setToMode('standard'); }
  async _onSleep()    { await this._setToMode('sleep'); }

  getCardSize() {
    return 4;
  }

  /* Lovelace editor integration: provide a simple schema-based editor using <ha-form>
     The editor will ask for:
       - device_name (required)
       - title (optional)
       - high_setting (optional)
       - low_setting (optional)
  */
  static async getConfigElement() {
    if (!customElements.get('spa-control-card-editor')) {
      class SpaControlCardEditor extends HTMLElement {
        setConfig(config) {
          this._config = config || {};
          // render once; subsequent setConfig calls update existing inputs to preserve caret/focus
          if (!this._inited) {
            this.render();
            this._inited = true;
            return;
          }

          // update input values in-place without re-rendering (preserve selection/caret)
          const dev = this.querySelector('#device_name');
          if (dev && document.activeElement !== dev && dev.value !== (this._config.device_name || '')) dev.value = this._config.device_name || '';
          const title = this.querySelector('#title');
          if (title && document.activeElement !== title && title.value !== (this._config.title || '')) title.value = this._config.title || '';
          const high = this.querySelector('#high_setting');
          const highVal = typeof this._config.high_setting !== 'undefined' ? String(this._config.high_setting) : '';
          if (high && document.activeElement !== high && high.value !== highVal) high.value = highVal;
          const low = this.querySelector('#low_setting');
          const lowVal = typeof this._config.low_setting !== 'undefined' ? String(this._config.low_setting) : '';
          if (low && document.activeElement !== low && low.value !== lowVal) low.value = lowVal;
          const modeToggle = this.querySelector('#show_mode_buttons');
          if (modeToggle) modeToggle.checked = this._config.show_mode_buttons !== false;
        }
        render() {
          this.innerHTML = '';
          const container = document.createElement('div');
          container.style.padding = '8px';
          container.style.display = 'flex';
          container.style.flexDirection = 'column';
          container.style.gap = '8px';

          const makeField = (labelText, id, type = 'text', required = false) => {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';

            const label = document.createElement('label');
            label.textContent = labelText;
            label.style.fontSize = '13px';
            label.style.marginBottom = '4px';
            wrapper.appendChild(label);

            const input = document.createElement('input');
            input.id = id;
            input.type = type;
            input.style.padding = '6px 8px';
            input.style.fontSize = '14px';
            input.style.border = '1px solid rgba(0,0,0,0.12)';
            input.required = !!required;
            if (type === 'number') input.step = '1';

            wrapper.appendChild(input);
            return { wrapper, input };
          };

          const devField = makeField('Device name (required)', 'device_name', 'text', true);
          const titleField = makeField('Title (optional)', 'title', 'text', false);
          const highField = makeField('High setting (optional)', 'high_setting', 'number', false);
          const lowField = makeField('Low setting (optional)', 'low_setting', 'number', false);

          // Toggle: show/hide mode buttons
          const modeToggleWrapper = document.createElement('div');
          modeToggleWrapper.style.display = 'flex';
          modeToggleWrapper.style.alignItems = 'center';
          modeToggleWrapper.style.gap = '8px';
          modeToggleWrapper.style.marginTop = '4px';
          const modeToggleInput = document.createElement('input');
          modeToggleInput.id = 'show_mode_buttons';
          modeToggleInput.type = 'checkbox';
          modeToggleInput.style.width = '18px';
          modeToggleInput.style.height = '18px';
          modeToggleInput.style.cursor = 'pointer';
          const modeToggleLabel = document.createElement('label');
          modeToggleLabel.htmlFor = 'show_mode_buttons';
          modeToggleLabel.textContent = 'Show Economy / Standard / Sleep mode buttons';
          modeToggleLabel.style.fontSize = '13px';
          modeToggleLabel.style.cursor = 'pointer';
          modeToggleWrapper.appendChild(modeToggleInput);
          modeToggleWrapper.appendChild(modeToggleLabel);

          container.appendChild(devField.wrapper);
          container.appendChild(titleField.wrapper);
          container.appendChild(highField.wrapper);
          container.appendChild(lowField.wrapper);
          container.appendChild(modeToggleWrapper);

          // populate values
          devField.input.value = this._config.device_name || '';
          titleField.input.value = this._config.title || '';
          highField.input.value = typeof this._config.high_setting !== 'undefined' ? this._config.high_setting : '';
          lowField.input.value = typeof this._config.low_setting !== 'undefined' ? this._config.low_setting : '';
          modeToggleInput.checked = this._config.show_mode_buttons !== false;

          // dispatch change events (debounced)
          let timeout = null;
          const dispatch = () => {
            const cfg = {
              type: 'custom:spa-control-card',
              device_name: devField.input.value.trim(),
              // preserve spaces the user types in the title field; only convert empty -> undefined
              title: titleField.input.value !== '' ? titleField.input.value : undefined,
              high_setting: highField.input.value !== '' ? Number(highField.input.value) : undefined,
              low_setting: lowField.input.value !== '' ? Number(lowField.input.value) : undefined,
              show_mode_buttons: modeToggleInput.checked,
            };
            this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: cfg } }));
          };
          const schedule = () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(dispatch, 250);
          };

          [devField.input, titleField.input, highField.input, lowField.input].forEach(i => {
            i.addEventListener('input', schedule);
          });
          modeToggleInput.addEventListener('change', dispatch);

          this.appendChild(container);
        }
      }
      customElements.define('spa-control-card-editor', SpaControlCardEditor);
    }
    return document.createElement('spa-control-card-editor');
  }

  static getStubConfig() {
    return { type: 'custom:spa-control-card', device_name: '', title: '', high_setting: undefined, low_setting: undefined, show_mode_buttons: true };
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