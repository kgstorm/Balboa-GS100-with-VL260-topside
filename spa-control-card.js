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
          <div style="display:flex;align-items:center;justify-content:center;padding:18px">
            <div id="big" style="display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div class="circle" style="width:160px;height:160px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--paper-card-background-color);box-shadow: inset 0 0 0 4px var(--primary-color, #03A9F4);">
                <div class="meas" style="font-size:40px;font-weight:700">—</div>
                <div class="set-row" style="margin-top:8px;font-size:16px;color:var(--secondary-text-color)"><span class="set-label">Set</span>: <span class="set">—</span></div>
                <div id="config_msg" style="margin-top:6px;font-size:12px;color:var(--error-color)"></div>
              </div>
            </div>
          </div>
        </ha-card>
      `;
      this.appendChild(this._container);
    }

    // optional label override for set prefix
    const setLabel = this.config.set_label || 'Set';
    const setLabelEl = this.querySelector('#big .set-label');
    if (setLabelEl) setLabelEl.textContent = setLabel;

    // Assign deterministic entity IDs based on device name (no guessing)
    // User specified: set entity = sensor.${device}_spa_set_temp
    if (!this.config.set_entity) this.config.set_entity = `sensor.${this._device_norm}_spa_set_temp`;
    if (!this.config.measured_entity) this.config.measured_entity = `sensor.${this._device_norm}_spa_measured_temp`;



    // initial update
    this._update();
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

  // Note: removed fuzzy/auto inference functions — entities are mapped deterministically now


  getCardSize() {
    return 2;
  }
}

if (!customElements.get('spa-control-card')) {
  customElements.define('spa-control-card', SpaControlCard);
} else {
  console.debug('spa-control-card already defined; skipping re-definition');
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
