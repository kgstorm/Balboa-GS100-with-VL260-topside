#pragma once

#include "esphome/core/component.h"
#include "esphome/core/preferences.h"
#include "esphome/components/web_server_base/web_server_base.h"

#include <atomic>
#include <string>

namespace esphome {
namespace setup_portal {

// Persisted in NVS. Bumped magic if the layout ever changes so stale
// contents are ignored rather than misinterpreted.
struct SetupSettings {
  char mode[8];       // "local" (native API) or "cloud" (MQTT)
  char broker[65];    // MQTT broker hostname
  uint16_t port;      // MQTT broker port
  char username[33];  // MQTT username
  char password[65];  // MQTT password
  uint32_t magic;     // validity marker
};

class SpaSetupPortal : public Component, public AsyncWebHandler {
 public:
  explicit SpaSetupPortal(web_server_base::WebServerBase *base) : base_(base) {}

  void setup() override;
  float get_setup_priority() const override { return setup_priority::WIFI + 1.0f; }

  bool canHandle(AsyncWebServerRequest *request) const override;
  void handleRequest(AsyncWebServerRequest *req) override;
  void set_mqtt_status(int status) { this->mqtt_status_.store(status); }

  // Used by YAML lambdas to apply the stored settings at boot.
  bool is_cloud_mode() const {
    return this->configured_ && strcmp(this->settings_.mode, "cloud") == 0;
  }
  std::string get_broker() const { return this->configured_ ? this->settings_.broker : ""; }
  uint16_t get_port() const { return this->configured_ ? this->settings_.port : 8883; }
  std::string get_username() const { return this->configured_ ? this->settings_.username : ""; }
  std::string get_password() const { return this->configured_ ? this->settings_.password : ""; }

 protected:
  void handle_save_(AsyncWebServerRequest *request, bool hotspot);
  void handle_setup_json_(AsyncWebServerRequest *request, bool hotspot);
  void serve_page_(AsyncWebServerRequest *request);

  web_server_base::WebServerBase *base_;
  ESPPreferenceObject rtc_;
  SetupSettings settings_{};
  std::atomic<int> mqtt_status_{-1};
  std::atomic<int> save_status_{0};
  bool configured_{false};
};

}  // namespace setup_portal
}  // namespace esphome
