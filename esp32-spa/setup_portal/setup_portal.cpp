#include "setup_portal.h"

#ifdef USE_ESP32

#include "esphome/core/application.h"
#include "esphome/core/log.h"
#include "esphome/components/captive_portal/captive_portal.h"
#include "esphome/components/json/json_util.h"
#include "esphome/components/wifi/wifi_component.h"

#include <cstdlib>
#include <cstring>
#include <esp_netif.h>
#include <lwip/sockets.h>

namespace esphome {
namespace setup_portal {

static const char *const TAG = "setup_portal";

// Marks a SetupSettings blob as valid. Bump if the layout changes.
static const uint32_t SETTINGS_MAGIC = 0xB41B0A01;

// Fixed preference key for this component's settings blob.
static const uint32_t PREF_HASH = 0x1D4A0F31;
static const char *const SETUP_PASSWORD = "balboawifi";

static const char SETUP_PAGE[] = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spa Module Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 1.5rem auto; padding: 0 1rem; color: #222; }
  fieldset { border: 1px solid #bbb; border-radius: .5rem; margin: 1rem 0; padding: .75rem 1rem 1rem; }
  legend { font-weight: 600; padding: 0 .4rem; }
  label { display: block; margin: .6rem 0 .2rem; font-weight: 500; }
  label.radio { display: flex; gap: .5rem; align-items: flex-start; font-weight: 400; margin: .6rem 0; }
  label.radio input { width: 1.25rem; height: 1.25rem; flex: 0 0 1.25rem; margin-top: .15rem; }
  input[type=text], input[type=password], input[type=number] { width: 100%; padding: .5rem; box-sizing: border-box; border: 1px solid #999; border-radius: .3rem; font-size: 1rem; }
  button { width: 100%; padding: .8rem; font-size: 1.05rem; font-weight: 600; color: #fff; background: #0a7ea4; border: 0; border-radius: .4rem; cursor: pointer; }
  small { color: #555; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>Spa Module Setup</h1>
<p id="status"></p>
<form id="f" method="POST" action="/save">
  <fieldset id="wifi-settings">
    <legend>Home WiFi</legend>
    <label class="radio"><input type="checkbox" id="keep-wifi" name="keep_wifi" value="yes"> Keep the current WiFi settings</label>
    <label for="ssid">WiFi network name</label>
    <input type="text" id="ssid" name="ssid" list="ssids" maxlength="32" required>
    <datalist id="ssids"></datalist>
    <label for="visible-networks">Visible networks</label>
    <select id="visible-networks"><option value="">Enter a network name or select one</option></select>
    <label for="psk">WiFi password</label>
    <input type="password" id="psk" name="psk" maxlength="64">
    <small>Leave blank to keep the saved password for the same network.</small>
    <label class="radio"><input type="checkbox" name="open_wifi" value="yes"> This is an open network (no password)</label>
  </fieldset>

  <fieldset>
    <legend>Where is your Home Assistant?</legend>
    <label class="radio">
      <input type="radio" name="mode" value="local" checked>
      <span><strong>On my home network</strong><br>
      <small>Home Assistant already runs in your home (Home Assistant Green, Raspberry&nbsp;Pi, a server&hellip;). Nothing else needed &mdash; it will find this module automatically.</small></span>
    </label>
    <label class="radio">
      <input type="radio" name="mode" value="cloud">
      <span><strong>In the cloud / I don&rsquo;t have it yet</strong><br>
      <small>Home Assistant runs on a cloud server. Enter the MQTT details printed at the end of the cloud setup script.</small></span>
    </label>
  </fieldset>

  <fieldset id="mqtt" class="hidden">
    <legend>Cloud connection (MQTT)</legend>
    <label for="broker">Broker address</label>
    <input type="text" id="broker" name="broker" placeholder="yourname-spa.duckdns.org">
    <label for="port">Port</label>
    <input type="number" id="port" name="port" value="8883" min="1" max="65535">
    <label for="user">Username</label>
    <input type="text" id="user" name="user">
    <label for="pass">Password</label>
    <input type="password" id="pass" name="pass">
    <small>Leave blank to keep the saved MQTT password.</small>
  </fieldset>

  <button type="submit">Save &amp; restart</button>
</form>
<script>
var mqtt = document.getElementById('mqtt');
var hotspot = false;
var keepWifi = document.getElementById('keep-wifi');
keepWifi.addEventListener('change', function () {
  document.getElementById('ssid').required = hotspot && !this.checked;
});
function syncMode() {
  mqtt.classList.toggle('hidden', document.querySelector('input[name=mode]:checked').value !== 'cloud');
}
document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', syncMode); });

function loadNetworks(attempt) {
fetch('/config.json').then(function (r) {
  if (!r.ok) throw new Error('Network list unavailable');
  return r.json();
}).then(function (d) {
  var dl = document.getElementById('ssids');
  var list = document.getElementById('visible-networks');
  var seen = {};
  d.aps.forEach(function (ap) {
    if (!ap.ssid || seen[ap.ssid]) return;
    seen[ap.ssid] = true;
    var o = document.createElement('option');
    o.value = ap.ssid;
    dl.appendChild(o);
    var choice = document.createElement('option');
    choice.value = ap.ssid;
    choice.textContent = ap.ssid + ' (' + ap.rssi + ' dBm)';
    list.appendChild(choice);
  });
  if (list.options.length === 1) {
    list.options[0].text = 'No networks found yet; enter the name manually or reload';
    if (attempt < 5) setTimeout(function () { loadNetworks(attempt + 1); }, 3000);
  }
}).catch(function () {
  document.getElementById('visible-networks').options[0].text = 'Network list unavailable; enter the name manually';
});
}
document.getElementById('visible-networks').addEventListener('change', function () {
  if (this.value) document.getElementById('ssid').value = this.value;
});

fetch('/setup.json').then(function (r) { return r.json(); }).then(function (s) {
  hotspot = s.hotspot;
  if (hotspot) loadNetworks(0);
  document.getElementById('wifi-settings').classList.toggle('hidden', !hotspot);
  document.getElementById('ssid').required = hotspot;
  document.getElementById('status').textContent = s.status;
  if (s.mode === 'cloud') {
    document.querySelector('input[name=mode][value=cloud]').checked = true;
    syncMode();
  }
  if (s.broker) document.getElementById('broker').value = s.broker;
  if (s.port) document.getElementById('port').value = s.port;
  if (s.username) document.getElementById('user').value = s.username;
}).catch(function () {
  document.getElementById('status').textContent = 'Could not load saved settings. Reload this page before saving.';
  document.querySelector('button').disabled = true;
});

document.getElementById('f').addEventListener('submit', function (e) {
  if (document.querySelector('input[name=mode]:checked').value === 'cloud' &&
      !document.getElementById('broker').value.trim()) {
    alert('Please enter the MQTT broker address from your cloud setup.');
    e.preventDefault();
  }
});
</script>
</body>
</html>
)rawliteral";

static const char SAVE_OK_PAGE[] = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spa Module Setup</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 1.5rem auto; padding: 0 1rem; color: #222; }
</style>
</head>
<body>
<h1>Saved</h1>
<p>Settings are being saved. Wait for confirmation before leaving this page.</p>
<p id="result">Saving...</p>
<p>If the module cannot join your WiFi, the setup hotspot will reappear after about a minute so you can try again.</p>
<script>
function checkSave() {
  fetch('/save-status', {cache: 'no-store'}).then(function (r) {
    if (!r.ok) throw new Error('Status unavailable');
    return r.text();
  }).then(function (s) {
    if (s === 'pending') { setTimeout(checkSave, 500); return; }
    document.getElementById('result').textContent = s === 'saved'
      ? 'Settings saved. The module is restarting. If you used the hotspot, reconnect to your normal WiFi.'
      : 'Saving failed. Check the WiFi password and open-network selection, then return to setup and try again. See device logs for details.';
  }).catch(function () {
    document.getElementById('result').textContent = 'Could not confirm the save. Reconnect and check the settings.';
  });
}
checkSave();
</script>
</body>
</html>
)rawliteral";

void SpaSetupPortal::setup() {
  this->rtc_ = global_preferences->make_preference<SetupSettings>(PREF_HASH);
  SetupSettings loaded{};
  if (this->rtc_.load(&loaded) && loaded.magic == SETTINGS_MAGIC) {
    // Ensure strings are terminated even if flash contents are corrupt.
    loaded.mode[sizeof(loaded.mode) - 1] = '\0';
    loaded.broker[sizeof(loaded.broker) - 1] = '\0';
    loaded.username[sizeof(loaded.username) - 1] = '\0';
    loaded.password[sizeof(loaded.password) - 1] = '\0';
    this->settings_ = loaded;
    this->configured_ = true;
    ESP_LOGI(TAG, "Loaded saved setup (mode=%s)", this->settings_.mode);
  }
  // Register before the captive portal registers itself in start(), so this
  // handler wins request dispatch while the fallback AP is up.
  this->base_->add_handler_without_auth(this);
  this->base_->init();
}

bool SpaSetupPortal::canHandle(AsyncWebServerRequest *request) const {
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
  if (request->method() == HTTP_POST)
    return true;
  if (request->method() != HTTP_GET)
    return false;
  if (url == ESPHOME_F("/") || url == ESPHOME_F("/setup") || url == ESPHOME_F("/setup.json") ||
      url == ESPHOME_F("/save-status") || url == ESPHOME_F("/save") ||
      url == ESPHOME_F("/config.json"))
    return true;
  return captive_portal::global_captive_portal != nullptr && captive_portal::global_captive_portal->is_active();
}

static bool get_destination_(AsyncWebServerRequest *request, in_addr *destination) {
  sockaddr_in address{};
  socklen_t len = sizeof(address);
  int fd = httpd_req_to_sockfd(*request);
  if (getsockname(fd, reinterpret_cast<sockaddr *>(&address), &len) != 0 || address.sin_family != AF_INET)
    return false;
  *destination = address.sin_addr;
  return true;
}

static bool is_hotspot_request_(const in_addr &destination) {
  if (captive_portal::global_captive_portal == nullptr || !captive_portal::global_captive_portal->is_active())
    return false;
  auto *ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  auto *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  esp_netif_ip_info_t ap_info{}, sta_info{};
  if (ap == nullptr || esp_netif_get_ip_info(ap, &ap_info) != ESP_OK || ap_info.ip.addr == 0 ||
      destination.s_addr != ap_info.ip.addr)
    return false;
  if (sta != nullptr) {
    if (esp_netif_get_ip_info(sta, &sta_info) != ESP_OK || sta_info.ip.addr == destination.s_addr)
      return false;
  }
  return true;
}

void SpaSetupPortal::handleRequest(AsyncWebServerRequest *req) {
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = req->url_to(url_buf);
  in_addr destination{};
  if (!get_destination_(req, &destination)) {
    req->send(403, ESPHOME_F("text/plain"), ESPHOME_F("Cannot determine request interface."));
    return;
  }
  bool hotspot = is_hotspot_request_(destination);
  auto host = req->get_header("Host");
  char ip[INET_ADDRSTRLEN];
  if (inet_ntop(AF_INET, &destination, ip, sizeof(ip)) == nullptr || !host.has_value()) {
    req->send(403, ESPHOME_F("text/plain"), ESPHOME_F("Invalid request host."));
    return;
  }
  std::string hostname = App.get_name() + ".local";
  if (*host != ip && *host != std::string(ip) + ":80" && *host != hostname && *host != hostname + ":80") {
    if (hotspot && req->method() == HTTP_GET) {
      req->redirect(std::string("http://") + ip + "/");
      return;
    }
    req->send(403, ESPHOME_F("text/plain"),
              ESPHOME_F("Open http://192.168.4.1 on the hotspot or the module's local address on your home network."));
    return;
  }
  if (!hotspot) {
    if (!req->authenticate("spa", SETUP_PASSWORD)) {
      req->requestAuthentication();
      return;
    }
  }

  if (req->method() == HTTP_POST && url != ESPHOME_F("/save")) {
    req->send(404, ESPHOME_F("text/plain"), ESPHOME_F("Not found."));
    return;
  }
  if (url == ESPHOME_F("/save")) {
    if (req->method() != HTTP_POST) {
      req->send(405, ESPHOME_F("text/plain"), ESPHOME_F("Use POST to save settings."));
      return;
    }
    auto origin = req->get_header("Origin");
    if (!origin.has_value() || *origin != "http://" + *host) {
      req->send(403, ESPHOME_F("text/plain"), ESPHOME_F("Invalid request origin."));
      return;
    }
    httpd_req_t *raw = *req;
    auto content_type = req->get_header("Content-Type");
    if (strchr(raw->uri, '?') != nullptr || !content_type.has_value() ||
        content_type->find("application/x-www-form-urlencoded") != 0) {
      req->send(400, ESPHOME_F("text/plain"), ESPHOME_F("Invalid form submission."));
      return;
    }
    this->handle_save_(req, hotspot);
    return;
  }
  if (url == ESPHOME_F("/save-status")) {
    int status = this->save_status_.load();
    req->send(200, ESPHOME_F("text/plain"), status == 1 ? "pending" : status == 2 ? "saved" : "failed");
    return;
  }
  if (url == ESPHOME_F("/setup.json")) {
    this->handle_setup_json_(req, hotspot);
    return;
  }
  if (url == ESPHOME_F("/config.json")) {
    if (hotspot) {
      auto json = json::build_json([](JsonObject root) {
        JsonArray aps = root["aps"].to<JsonArray>();
        for (const auto &scan : wifi::global_wifi_component->get_scan_result()) {
          if (scan.get_is_hidden())
            continue;
          JsonObject ap = aps.add<JsonObject>();
          ap["ssid"] = scan.get_ssid().c_str();
          ap["rssi"] = scan.get_rssi();
        }
      });
      req->send(200, ESPHOME_F("application/json"), json.c_str());
    } else {
      req->send(404, ESPHOME_F("text/plain"), ESPHOME_F("Network scanning is only available on the hotspot."));
    }
    return;
  }
  this->serve_page_(req);
}

static bool copy_field_(char *dst, size_t dst_size, const std::string &src) {
  if (src.size() >= dst_size)
    return false;
  // Reject characters that would break the /setup.json prefill output.
  for (unsigned char c : src)
    if (c < 0x20 || c == '"' || c == '\\')
      return false;
  memcpy(dst, src.c_str(), src.size() + 1);
  return true;
}

static bool copy_password_(char *dst, size_t dst_size, const std::string &src) {
  if (src.size() >= dst_size || src.find('\0') != std::string::npos)
    return false;
  memcpy(dst, src.c_str(), src.size() + 1);
  return true;
}

void SpaSetupPortal::handle_save_(AsyncWebServerRequest *request, bool hotspot) {
  std::string ssid = request->arg("ssid");
  std::string psk = request->arg("psk");
  std::string mode = request->arg("mode");
  std::string broker = request->arg("broker");
  std::string port_str = request->arg("port");
  std::string username = request->arg("user");
  std::string password = request->arg("pass");
  bool open_wifi = hotspot && request->arg("open_wifi") == "yes";
  bool keep_wifi = hotspot && request->arg("keep_wifi") == "yes";

  SetupSettings next = this->settings_;
  next.magic = SETTINGS_MAGIC;
  char *end = nullptr;
  long port = port_str.empty() ? 8883 : strtol(port_str.c_str(), &end, 10);
  bool valid_port = port_str.empty() || (end != port_str.c_str() && *end == '\0' && port >= 1 && port <= 65535);
  next.port = (uint16_t) port;

  bool ok = (mode == "local" || mode == "cloud") && (!hotspot || keep_wifi || (!ssid.empty() && ssid.size() <= 32)) &&
            ssid.find('\0') == std::string::npos && psk.size() <= 64 && psk.find('\0') == std::string::npos &&
            valid_port && copy_field_(next.mode, sizeof(next.mode), mode);
  if (mode == "cloud") {
    if (password.empty() && this->configured_)
      password = this->settings_.password;
    ok = ok && !broker.empty() && copy_field_(next.broker, sizeof(next.broker), broker) &&
         copy_field_(next.username, sizeof(next.username), username) &&
         copy_password_(next.password, sizeof(next.password), password);
  }

  if (!ok) {
    request->send(400, ESPHOME_F("text/plain"), ESPHOME_F("Invalid or too-long value in form. Please go back and try again."));
    return;
  }

  int previous_status = this->save_status_.load();
  if (previous_status == 1 || previous_status == 2 ||
      !this->save_status_.compare_exchange_strong(previous_status, 1)) {
    request->send(409, ESPHOME_F("text/plain"), ESPHOME_F("A save is already in progress."));
    return;
  }
  request->send(200, ESPHOME_F("text/html"), SAVE_OK_PAGE);

  // NVS writes and the reboot must happen on the main loop, not the HTTP thread.
  this->defer([this, next, ssid, psk, hotspot, open_wifi, keep_wifi]() mutable {
    if (hotspot && !keep_wifi && psk.empty() && !open_wifi) {
      auto sta = wifi::global_wifi_component->get_sta();
      if (ssid != sta.get_ssid().c_str() || sta.get_password().empty()) {
        ESP_LOGE(TAG, "WiFi password required unless an open network is selected");
        this->save_status_.store(-1);
        return;
      }
      psk = sta.get_password().c_str();
    }
    if (hotspot && !keep_wifi && open_wifi)
      psk.clear();
    if (!this->rtc_.save(&next) || !global_preferences->sync()) {
      ESP_LOGE(TAG, "Failed to save MQTT settings");
      this->save_status_.store(-1);
      return;
    }
    if (hotspot && !keep_wifi)
      wifi::global_wifi_component->save_wifi_sta(ssid, psk);
    ESP_LOGI(TAG, "Saved setup settings; restarting");
    this->save_status_.store(2);
    this->set_timeout(5000, []() { App.safe_reboot(); });
  });
}

void SpaSetupPortal::handle_setup_json_(AsyncWebServerRequest *request, bool hotspot) {
  // Never returns the stored password.
  const char *status = "MQTT connection pending or unavailable; check the device logs for details.";
  switch (this->mqtt_status_.load()) {
    case -2: status = "MQTT connected."; break;
    case 0: status = "MQTT disconnected; check broker address, port, TLS and credentials."; break;
    case 3: status = "MQTT server unavailable."; break;
    case 4: case 5: status = "MQTT credentials rejected."; break;
    case 7: status = "MQTT TLS verification failed."; break;
    case 8: status = "MQTT broker address could not be resolved."; break;
    default: break;
  }
  if (!this->is_cloud_mode())
    status = "Local Home Assistant mode; MQTT is disabled.";
  char buf[360];
  snprintf(buf, sizeof(buf), "{\"mode\":\"%s\",\"broker\":\"%s\",\"port\":%u,\"username\":\"%s\",\"hotspot\":%s,\"status\":\"%s\"}",
           this->configured_ ? this->settings_.mode : "local", this->configured_ ? this->settings_.broker : "",
           this->configured_ ? this->settings_.port : 8883, this->configured_ ? this->settings_.username : "",
           hotspot ? "true" : "false", status);
  request->send(200, ESPHOME_F("application/json"), buf);
}

void SpaSetupPortal::serve_page_(AsyncWebServerRequest *request) {
  auto *response = request->beginResponse(200, ESPHOME_F("text/html"), (const uint8_t *) SETUP_PAGE,
                                          sizeof(SETUP_PAGE) - 1);
  request->send(response);
}

}  // namespace setup_portal
}  // namespace esphome

#endif  // USE_ESP32
