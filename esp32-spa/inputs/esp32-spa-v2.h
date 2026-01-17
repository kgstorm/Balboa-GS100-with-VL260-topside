#pragma once

#include "esphome.h"
#include "esphome/core/log.h"
#include "esphome/components/sensor/sensor.h"  // ensure Sensor base class is available

// Forward-declare binary sensor to avoid requiring the header at this point
namespace esphome { namespace binary_sensor { class BinarySensor; } }

// ESP-IDF / FreeRTOS headers
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "esp_timer.h"

// Forward declaration of C ISR wrapper (defined after the namespace)
extern "C" void esp32_spa_v2_isr_wrapper(void* arg);

static const char *TAG = "esp32-spa-v2";

// ===== PIN DEFINITIONS =====
// Using input-only GPIOs on ESP32: CLK=GPIO35, DATA=GPIO34
// Note: GPIO34/35 are input-only and do NOT support internal pull-ups; use external pull resistors (e.g., 10k) and a small series resistor on the clock (~47-220 ohm).
static const uint8_t CLK_PIN  = 35;  // Clock (input-only)
static const uint8_t DATA_PIN = 34;  // Data (input-only)

// Button output pins used to inject presses. These are boot-safe GPIOs and match
// the values in `esp32-spa-v2.yaml` (Warm=25, Cool=26, Lights=27, Pumps=32).
#define PIN_WRITE_BTN1 25  // Warm
#define PIN_WRITE_BTN2 26  // Cool
#define PIN_WRITE_BTN3 27  // Lights
#define PIN_WRITE_PUMP 32  // Pumps

namespace esp32_spa_v2 {

class HotTubDisplaySensor : public esphome::Component, public esphome::sensor::Sensor {
 public:
  // ---- Shared with ISR ----
  volatile uint32_t shift_reg = 0;
  volatile uint8_t bit_count = 0;
  volatile bool frame_ready = false;
  // Note: removed time-based gap detection in ISR to avoid calling non-IRAM functions from ISR

  // ---- Debug control ----
  bool debug_enabled = false;

  // ---- Publish control ----
  uint32_t last_publish_time = 0;
  uint32_t last_published_value = 0;
  bool first_publish = true;
  volatile bool last_frame_valid = false;  // becomes true when a frame passes the checksum and is published

  // Remember last decoded values for change detection
  int16_t last_measured_temp = -1;  // -1 = unknown
  int16_t last_set_temp = -1;       // -1 = unknown
  int16_t set_temp_potential = -1;  // candidate for set temp
  uint32_t last_zero_seen_time = 0; // last time we saw 0x00 in p2/p3
  uint32_t last_candidate_temp_time = 0; // last time we saw a candidate temp while in set mode
  bool in_set_mode = false;         // true when we've seen 0x00 recently

  // Stability tracking (counters and candidates)
  int16_t candidate_temp = -2; uint8_t stable_temp = 0;
  bool candidate_is_zero = false; uint8_t stable_zero = 0;
  // Heater stability (derived from bit5 of p1)
  int8_t candidate_heater = -2; uint8_t stable_heater = 0;
  // Pump & light stability (derived from p4 bits)
  int8_t candidate_pump = -1; uint8_t stable_pump = 0;
  int8_t candidate_light = -1; uint8_t stable_light = 0;

  // Sensors for temperature readings
  esphome::sensor::Sensor *measured_temp_sensor_ = nullptr;
  esphome::sensor::Sensor *set_temp_sensor_ = nullptr;

  // Binary sensors for discrete states
  esphome::binary_sensor::BinarySensor *heater_sensor_ = nullptr;  // derived from p1 bit5
  esphome::binary_sensor::BinarySensor *pump_sensor_ = nullptr;    // derived from p4 bit0
  esphome::binary_sensor::BinarySensor *light_sensor_ = nullptr;   // derived from p4 bit1

  // Last published discrete states
  int8_t last_heater = -1;  // -1=unknown, otherwise 0/1
  int8_t last_pump = -1;    // -1=unknown, otherwise 0/1
  int8_t last_light = -1;   // -1=unknown, otherwise 0/1

  static constexpr uint32_t HEARTBEAT_MS = 30000;  // heartbeat every 30s (publish if unchanged)
  // Gap threshold (ms) to consider the start of a new frame (use ~15ms to match ~19ms observed gap)
  static constexpr uint32_t FRAME_GAP_MS =5;
  static constexpr uint32_t FRAME_GAP_US = FRAME_GAP_MS * 1000;

  // Stability filtering: require this many consecutive identical decoded frames before publishing
  // Increased to 2 to reduce spurious publishes from brief noise
  static constexpr uint8_t STABLE_THRESHOLD = 2;
  static constexpr uint8_t PUMP_STABLE_THRESHOLD = 3;  // pump requires 4 repeats to be considered stable
  static constexpr uint32_t SET_MODE_TIMEOUT_MS = 2000;  // 2 seconds without 0x00 = exit set mode
  static constexpr uint32_t HEATER_OFF_TIMEOUT_MS = 1000; // heater must be off for 1s before clearing

  // Timestamp to track when heater bit last went low while heater was on
  uint32_t last_heater_off_time = 0;

  // --- Auto-refresh set-temp logic ---
  // When we capture & publish the set temp, reset this timer. If no set-temp is captured
  // for SET_FORCE_INTERVAL_MS milliseconds we auto-press COOL once to force the tub to
  // display and send the set temperature. We also update the timer when we auto-press.
  uint32_t last_set_sent_time_ms = 0;
  static constexpr uint32_t SET_FORCE_INTERVAL_MS = 5u * 60u * 1000u;  // 5 minutes
  
  // Setters called from Python binding
  void set_measured_temp_sensor(esphome::sensor::Sensor *s) { measured_temp_sensor_ = s; }
  void set_set_temp_sensor(esphome::sensor::Sensor *s) { set_temp_sensor_ = s; }

  // Binary sensor setters
  void set_heater_sensor(esphome::binary_sensor::BinarySensor *s) { heater_sensor_ = s; }
  void set_pump_sensor(esphome::binary_sensor::BinarySensor *s) { pump_sensor_ = s; }
  void set_light_sensor(esphome::binary_sensor::BinarySensor *s) { light_sensor_ = s; }

  
  // Decode temperature from p1, p2, p3
  // p2 = tens digit, p3 = ones digit, bits 5&4 of p1 both high = add 100
  static int16_t decode_temp(uint8_t p1, int8_t d2, int8_t d3) {
    if (d2 < 0 || d3 < 0) return -1;  // invalid digits
    int16_t temp = d2 * 10 + d3;
    // Check bits 5 and 4 of p1 (0b00110000 = 0x30)
    if ((p1 & 0x30) == 0x30) {
      temp += 100;
    }
    return temp;
  }
  static int8_t decode_7seg(uint8_t seg) {
    // bit ordering: bit6=a(top), bit5=b(upper right), bit4=c(lower right), bit3=d(bottom), bit2=e(lower left), bit1=f(upper left), bit0=g(middle)
    static const uint8_t map[10] = {
      0b1111110, // 0
      0b0110000, // 1
      0b1101101, // 2
      0b1111001, // 3
      0b0110011, // 4
      0b1011011, // 5
      0b1011111, // 6
      0b1110000, // 7
      0b1111111, // 8
      0b1110011  // 9
    };

    // Exact match first
    for (uint8_t d = 0; d < 10; ++d) {
      if (seg == map[d]) return static_cast<int8_t>(d);
    }

    // Helper: hamming distance (XOR population count)
    auto hamming = [](uint8_t a, uint8_t b) {
      return __builtin_popcount(static_cast<unsigned>(a ^ b));
    };

    // Try tolerant match (allow 1-bit error)
    uint8_t best_d = 0xFF;
    int best_dist = 100;
    for (uint8_t d = 0; d < 10; ++d) {
      int dist = hamming(seg, map[d]);
      if (dist < best_dist) { best_dist = dist; best_d = d; }
    }
    if (best_dist <= 1) return static_cast<int8_t>(best_d);

    // Try reversed bit order (maybe wiring/order is reversed)
    uint8_t rev = 0;
    for (int i = 0; i < 7; ++i) {
      rev |= ((seg >> i) & 0x1) << (6 - i);
    }

    for (uint8_t d = 0; d < 10; ++d) {
      if (rev == map[d]) return static_cast<int8_t>(d);
    }
    // Try tolerant on reversed
    best_d = 0xFF; best_dist = 100;
    for (uint8_t d = 0; d < 10; ++d) {
      int dist = hamming(rev, map[d]);
      if (dist < best_dist) { best_dist = dist; best_d = d; }
    }
    if (best_dist <= 1) return static_cast<int8_t>(best_d);

    return -1;
  }

  void setup() override {
    // Configure both pins as inputs (no internal pull); external pull resistors expected
    gpio_config_t io_conf{};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pin_bit_mask = (1ULL << CLK_PIN) | (1ULL << DATA_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);

    // Install ISR service and attach to clock pin (rising edge)
    gpio_install_isr_service(0);
    // Use plain C ISR wrapper function to avoid linker relocation issues with C++ static member wrappers
    gpio_isr_handler_add((gpio_num_t)CLK_PIN, &esp32_spa_v2_isr_wrapper, this);
    gpio_set_intr_type((gpio_num_t)CLK_PIN, GPIO_INTR_POSEDGE);

    // Initialize auto-refresh timer to avoid an immediate forced press on boot
    last_set_sent_time_ms = esphome::millis();

    // Ensure COOL button pin is setup as an output (harmless if balboa_custom also configures it)
    gpio_set_direction((gpio_num_t)PIN_WRITE_BTN2, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)PIN_WRITE_BTN2, 0);

    // Press COOL shortly after boot to initialize/set the displayed set-temp
    // Press on at 1.5s, release at 1.7s. Update the last_set_sent_time when pressed.
    this->set_timeout("boot_press_cool_on", 1500, [this]() {
      ESP_LOGI(TAG, "Boot: auto-pressing COOL to initialize set temp");
      gpio_set_level((gpio_num_t)PIN_WRITE_BTN2, 1);
      last_set_sent_time_ms = esphome::millis();
    });
    this->set_timeout("boot_press_cool_off", 1700, []() {
      gpio_set_level((gpio_num_t)PIN_WRITE_BTN2, 0);
    });
  }

  void loop() override {
    uint32_t now = esphome::millis();

    // Report any partial/incomplete frames detected by ISR since last check
    uint32_t partials = 0;
    portENTER_CRITICAL(&spinlock_);
    partials = partial_frame_count;
    partial_frame_count = 0;
    if (partials > 0) {
      // Invalidate stored frame here instead of inside ISR to keep ISR short and non-blocking
      last_frame_valid = false;
    }
    portEXIT_CRITICAL(&spinlock_);
    if (partials > 0 && debug_enabled) {
      ESP_LOGW(TAG, "Dropped %u partial/incomplete frames (gaps before 24 bits)", partials);
    }

    // If no new frame, allow heartbeat publishes of last known value (only if last frame was valid)
    if (!frame_ready) {
      bool heartbeat_due = (now - last_publish_time >= HEARTBEAT_MS);

      // If the set-temp hasn't been captured for a while, force a 'cool' press to make the tub show/publish it
      if ((now - last_set_sent_time_ms) >= SET_FORCE_INTERVAL_MS) {
        ESP_LOGI(TAG, "No set-temp captured for %ums — auto-pressing COOL to refresh set temp", static_cast<unsigned>(now - last_set_sent_time_ms));
        // Activate the physical COOL press (use balboa pin macro)
        gpio_set_level((gpio_num_t)PIN_WRITE_BTN2, 1);
        // Ensure we release it after a short duration (mirror existing press timing)
        this->set_timeout("auto_press_cool", 200, [](){ gpio_set_level((gpio_num_t)PIN_WRITE_BTN2, 0); });
        // Update timer to avoid repeated presses
        last_set_sent_time_ms = now;
        // Also reset heartbeat timing so we don't immediately publish stale data
        last_publish_time = now;
      }

      if (!heartbeat_due) return;

      // Read protected copy of last_frame_valid to avoid races with ISR
      portENTER_CRITICAL(&spinlock_);
      bool lfv = last_frame_valid;
      portEXIT_CRITICAL(&spinlock_);

      if (!lfv) {
        // No valid stored frame — still publish any known stored values (measured/set/binary) so HA sees activity
        if (measured_temp_sensor_ && last_measured_temp >= 0) measured_temp_sensor_->publish_state(static_cast<float>(last_measured_temp));
        if (set_temp_sensor_ && last_set_temp >= 0) set_temp_sensor_->publish_state(static_cast<float>(last_set_temp));
        if (heater_sensor_ && last_heater >= 0) { heater_sensor_->publish_state(static_cast<bool>(last_heater)); }
        if (pump_sensor_ && last_pump >= 0) { pump_sensor_->publish_state(static_cast<bool>(last_pump)); }
        if (light_sensor_ && last_light >= 0) { light_sensor_->publish_state(static_cast<bool>(last_light)); }

        ESP_LOGI(TAG, "Heartbeat publish (stored): measured=%d set=%d heater=%d pump=%d light=%d", last_measured_temp, last_set_temp, last_heater, last_pump, last_light);

        last_publish_time = now;
        return;
      }

      uint32_t out = last_published_value & 0xFFFFFF;

      uint8_t p1 = (out >> 17) & 0x7F;  // top 7 bits
      uint8_t p2 = (out >> 10) & 0x7F;  // next 7 bits
      uint8_t p3 = (out >> 3)  & 0x7F;  // next 7 bits
      uint8_t p4 = out & 0x7;          // last 3 bits

      // Decode/validate exactly like new frames
      // Require p1 to match pattern 0xx0x00 (bits 6,3,1,0 must be zero)
      // AND require the least-significant bit of p4 to be 0 (LSB of status nibble)
      const uint8_t checksum_mask = 0x4B;  // 0b1001011 (mask bits 6,3,1,0)
      const uint8_t checksum_val  = 0x00;  // expected zeros in masked bits
      const uint8_t p4_mask = 0x1;        // require p4 LSB == 0
      if ((p1 & checksum_mask) != checksum_val || (p4 & p4_mask) != 0) {
        ESP_LOGW(TAG, "Heartbeat: stored frame fails checksum (p1 masked=0x%02X expected=0x%02X, p4_lsb=0x%X expected=0x0), not publishing",
                static_cast<unsigned>(p1 & checksum_mask), static_cast<unsigned>(checksum_val), static_cast<unsigned>(p4 & p4_mask));
        return;
      }

      uint8_t seg_b = (p1 >> 5) & 0x1;
      uint8_t seg_c = (p1 >> 4) & 0x1;
      int8_t digit2 = decode_7seg(p2);
      int8_t digit3 = decode_7seg(p3);

      int16_t temp = decode_temp(p1, digit2, digit3);

      // Heartbeat: publish binary sensor states as well
      // Heater is on bit 2 of p1 (observed from hardware)
      int heater_val = static_cast<int>((p1 >> 2) & 0x1);
      int pump_val = static_cast<int>((p4 >> 2) & 0x1);
      int light_val = static_cast<int>((p4 >> 1) & 0x1);

      // Log at info level so this appears even when debug is off
      ESP_LOGI(TAG, "Heartbeat publish: temp=%d set=%d status=0x%X heater=%d pump=%d light=%d", temp, last_set_temp, static_cast<unsigned>(p4), heater_val, pump_val, light_val);

      if (measured_temp_sensor_ && temp >= 0) measured_temp_sensor_->publish_state(static_cast<float>(temp));
      if (set_temp_sensor_ && last_set_temp >= 0) set_temp_sensor_->publish_state(static_cast<float>(last_set_temp));
      if (heater_sensor_) { heater_sensor_->publish_state(static_cast<bool>(heater_val)); last_heater = heater_val; }
      if (pump_sensor_) { pump_sensor_->publish_state(static_cast<bool>(pump_val)); last_pump = pump_val; }
      if (light_sensor_) { light_sensor_->publish_state(static_cast<bool>(light_val)); last_light = light_val; }

      last_publish_time = now;
      first_publish = false;
      return;
    }

    // Copy shared data under spinlock to avoid races with ISR
    portENTER_CRITICAL(&spinlock_);
    uint32_t value = shift_reg;
    frame_ready = false;
    portEXIT_CRITICAL(&spinlock_);

    // Decode the frame and detect changes using decoded digits (not raw 24-bit value)
    uint32_t out = value & 0xFFFFFF;

    // Split into parts
    uint8_t p1 = (out >> 17) & 0x7F;  // top 7 bits
    uint8_t p2 = (out >> 10) & 0x7F;  // next 7 bits
    uint8_t p3 = (out >> 3)  & 0x7F;  // next 7 bits
    uint8_t p4 = out & 0x7;          // last 3 bits

    // Verify checksum to filter invalid frames
    const uint8_t checksum_mask = 0x4B;  // 0b1001011 (mask bits 6,3,1,0)
    const uint8_t checksum_val  = 0x00;  // expected zeros in masked bits
    const uint8_t p4_mask = 0x1;        // require p4 LSB == 0
    if ((p1 & checksum_mask) != checksum_val || (p4 & p4_mask) != 0) {
      if (debug_enabled) {
        ESP_LOGW(TAG, "Frame fails checksum (p1 masked=0x%02X expected=0x%02X, p4_lsb=0x%X), ignoring",
                static_cast<unsigned>(p1 & checksum_mask), static_cast<unsigned>(checksum_val), static_cast<unsigned>(p4 & p4_mask));
      }
      // Treat as non-existent frame
      last_frame_valid = false;
      return;
    }

    // Small debug: log raw frame and parts (useful when debug switch is enabled)
    if (debug_enabled) {
      ESP_LOGD(TAG, "Frame received raw=0x%06X p1=0x%02X p2=0x%02X p3=0x%02X p4=0x%X", out, static_cast<unsigned>(p1), static_cast<unsigned>(p2), static_cast<unsigned>(p3), static_cast<unsigned>(p4));
    }

    // Decode the 7-seg patterns to digits
    int8_t digit2 = decode_7seg(p2);
    int8_t digit3 = decode_7seg(p3);

    // Check if this is a zero display (both raw bytes are 0x00).
    // Previously required decoded digits to be 0 too, but blank frames decode to -1 and were missed.
    bool is_zero = (p2 == 0x00 && p3 == 0x00);

    // Stability update for zero detection
    if (candidate_is_zero == is_zero) {
      if (stable_zero < 255) stable_zero++;
    } else {
      candidate_is_zero = is_zero;
      stable_zero = 1;
    }

    if (debug_enabled && is_zero) {
      ESP_LOGD(TAG, "Zero raw detected: p2=0x%02X p3=0x%02X decoded d2=%d d3=%d", static_cast<unsigned>(p2), static_cast<unsigned>(p3), digit2, digit3);
    }

    // Decode temperature if not zero
    int16_t temp = -1;
    if (!is_zero && digit2 >= 0 && digit3 >= 0) {
      temp = decode_temp(p1, digit2, digit3);
    }

    // Stability update for temperature
    if (candidate_temp == temp) {
      if (stable_temp < 255) stable_temp++;
    } else {
      candidate_temp = temp;
      stable_temp = 1;
    }

    // Record when we last saw a candidate temperature (even if transient)
    if (candidate_temp >= 0) {
      last_candidate_temp_time = now;
    }

    // Check if we should commit stable values
    bool zero_stable = (stable_zero >= STABLE_THRESHOLD);
    bool temp_stable = (stable_temp >= STABLE_THRESHOLD);

    // Set mode logic: detect 0x00 alternation pattern
    if (zero_stable && candidate_is_zero) {
      // We just saw stable zeros - update last_zero_seen_time
      last_zero_seen_time = now;

      // If we saw a recent candidate temp (even just-before the zero), accept it as potential
      if (set_temp_potential < 0 && candidate_temp >= 0 && (now - last_candidate_temp_time <= 3000)) {
        set_temp_potential = candidate_temp;
        if (debug_enabled) {
          ESP_LOGD(TAG, "Zero detected and recent candidate found: set_temp_potential=%d (age=%ums)", set_temp_potential, static_cast<unsigned>(now - last_candidate_temp_time));
        }
      }

      in_set_mode = true;
      
      if (debug_enabled) {
        ESP_LOGD(TAG, "Zero detected (0x00), entering/staying in set mode");
      }
    } else if (candidate_temp >= 0 && in_set_mode) {
      // We have observed a non-zero temp while already in set mode. Set as potential immediately
      if (set_temp_potential != candidate_temp) {
        set_temp_potential = candidate_temp;
        last_candidate_temp_time = now;
        if (debug_enabled) {
          ESP_LOGD(TAG, "Set temp potential updated (transient): %d", set_temp_potential);
        }
      } else {
        // refresh timestamp even if same potential
        last_candidate_temp_time = now;
      }
    }

    // Check if we should exit set mode (no zeros for 5 seconds)
    if (in_set_mode && (now - last_zero_seen_time >= SET_MODE_TIMEOUT_MS)) {
      in_set_mode = false;
      set_temp_potential = -1;
      if (debug_enabled) {
        ESP_LOGD(TAG, "Exited set mode (timeout)");
      }
    }

    // Publish set temp if we have a potential and see another zero
    if (zero_stable && candidate_is_zero && set_temp_potential >= 0 && set_temp_potential != last_set_temp) {
      // Optional safety: ensure the candidate temp was seen recently (within 3s) to avoid stale data
      if (now - last_candidate_temp_time <= 3000) {
        last_set_temp = set_temp_potential;
        if (set_temp_sensor_) {
          set_temp_sensor_->publish_state(static_cast<float>(last_set_temp));
          if (debug_enabled) {
            ESP_LOGD(TAG, "Publishing set temp: %d [confirmed by zero]", last_set_temp);
          }
        }
        // Reset the auto-refresh timer since we successfully captured & published a set temp
        last_set_sent_time_ms = now;
        last_publish_time = now;
      } else if (debug_enabled) {
        ESP_LOGW(TAG, "Set temp potential too old (%ums), ignoring", static_cast<unsigned>(now - last_candidate_temp_time));
      }
    }

    // Publish measured temp if not in set mode and temp is stable and changed
    if (!in_set_mode && temp_stable && candidate_temp >= 0 && candidate_temp != last_measured_temp) {
      last_measured_temp = candidate_temp;
      if (measured_temp_sensor_) {
        measured_temp_sensor_->publish_state(static_cast<float>(last_measured_temp));
        if (debug_enabled) {
          ESP_LOGD(TAG, "Publishing measured temp: %d", last_measured_temp);
        }
      }
      last_publish_time = now;
    }

    // Always update binary sensors from p4 and p1 with per-bit stability
    uint8_t p1_bits = p1;
    int8_t cur_heater = static_cast<int8_t>((p1_bits >> 2) & 0x1);
    int8_t cur_pump = static_cast<int8_t>((p4 >> 2) & 0x1);
    int8_t cur_light = static_cast<int8_t>((p4 >> 1) & 0x1);

    // Update heater stability (existing)
    if (candidate_heater == cur_heater) { if (stable_heater < 255) stable_heater++; } else { candidate_heater = cur_heater; stable_heater = 1; }

    // Update pump stability
    if (candidate_pump == cur_pump) {
      if (stable_pump < 255) stable_pump++;
    } else {
      candidate_pump = cur_pump; stable_pump = 1;
    }

    // Update light stability
    if (candidate_light == cur_light) {
      if (stable_light < 255) stable_light++;
    } else {
      candidate_light = cur_light; stable_light = 1;
    }

    // Determine which values are stable enough to publish
    bool pump_ok = (stable_pump >= PUMP_STABLE_THRESHOLD);
    bool light_ok = (stable_light >= STABLE_THRESHOLD);

    // Heater hysteresis: turn ON immediately when bit set; only turn OFF after it has been clear for HEATER_OFF_TIMEOUT_MS
    int8_t pub_heater = last_heater;
    if (cur_heater == 1) {
      // immediate on
      pub_heater = 1;
      last_heater_off_time = 0;
    } else {
      // cur_heater == 0
      if (last_heater == 1) {
        if (last_heater_off_time == 0) last_heater_off_time = now;
        if ((now - last_heater_off_time) >= HEATER_OFF_TIMEOUT_MS) {
          pub_heater = 0;
          last_heater_off_time = 0;
        } else {
          pub_heater = 1; // stay on until timeout
        }
      } else {
        pub_heater = 0;
      }
    }

    int8_t pub_pump = pump_ok ? candidate_pump : last_pump;
    int8_t pub_light = light_ok ? candidate_light : last_light;

    bool binary_changed = (pub_heater != last_heater || pub_pump != last_pump || pub_light != last_light);
    if (binary_changed) {
      if (debug_enabled) {
        ESP_LOGD(TAG, "Binary sensors updated: heater=%d pump=%d light=%d (stable: h=%u p=%u l=%u)", pub_heater, pub_pump, pub_light, static_cast<unsigned>(stable_heater), static_cast<unsigned>(stable_pump), static_cast<unsigned>(stable_light));
      }
      if (heater_sensor_) { heater_sensor_->publish_state(static_cast<bool>(pub_heater)); last_heater = pub_heater; }
      if (pump_sensor_) { pump_sensor_->publish_state(static_cast<bool>(pub_pump)); last_pump = pub_pump; }
      if (light_sensor_) { light_sensor_->publish_state(static_cast<bool>(pub_light)); last_light = pub_light; }
      
      if (debug_enabled) {
        ESP_LOGD(TAG, "Binary sensors updated: heater=%d pump=%d light=%d", pub_heater, pub_pump, pub_light);
      }

      last_published_value = value;
      last_publish_time = now;
      first_publish = false;
      portENTER_CRITICAL(&spinlock_);
      last_frame_valid = true;
      portEXIT_CRITICAL(&spinlock_);
    } else if (debug_enabled) {
      // No change; do not publish
      ESP_LOGD(TAG, "No changes detected");
    }
  }

  // Called by HA switch
  void set_debug(bool enabled) {
    debug_enabled = enabled;
    ESP_LOGI(TAG, "Debug logging %s", enabled ? "ENABLED" : "DISABLED");
  }

  // Public dispatcher safely callable from C ISR wrapper
  void IRAM_ATTR handle_isr() { this->on_clock_edge_isr(); }

 private:
  // Spinlock for protecting shared variables between ISR and loop
  portMUX_TYPE spinlock_ = portMUX_INITIALIZER_UNLOCKED;

  // ISR timing for frame gap detection (CPU cycle-count of last clock edge)
  // We avoid esp_timer_get_time() in ISR; use CPU cycle count and a fixed NOP delay to sample later.
  volatile uint32_t last_clock_ccount = 0;  // low-overhead 32-bit cycle counter (wraps naturally)

  // Count partial/incomplete frames detected by ISR (incremented when a gap resets a non-24-bit frame)
  volatile uint32_t partial_frame_count = 0;

  // CPU frequency assumptions and derived constants for timing
  static constexpr uint32_t CPU_MHZ = 240u;                // ESP32 clock (MHz)
  static constexpr uint32_t CYCLES_PER_US = CPU_MHZ;       // cycles per microsecond
  static constexpr uint32_t FRAME_GAP_CYCLES = FRAME_GAP_US * CYCLES_PER_US;

  // Fixed-cycle sampling delay implemented with cycle-count busy-wait to sample after clock rising edge
  // 240 MHz -> 240 cycles/us -> 8 us -> 1920 cycles
  static constexpr uint32_t SAMPLE_DELAY_US = 1u;          // target sample delay in microseconds
  static constexpr uint32_t SAMPLE_DELAY_CYCLES = SAMPLE_DELAY_US * CYCLES_PER_US;

  // Read cycle counter (IRAM safe)
  static inline uint32_t IRAM_ATTR get_cycle_count() {
    uint32_t ccount;
    asm volatile ("rsr.ccount %0" : "=a" (ccount));
    return ccount;
  }

  // Removed C++ static wrapper to avoid relocation/linker issues. A plain C ISR wrapper is defined at global scope.

  void IRAM_ATTR on_clock_edge_isr() {
    // ISR: detect frame gap by measuring cycles since last clock edge using CPU ccount
    // If gap > FRAME_GAP_CYCLES we treat as new frame and reset bit counter.

    portENTER_CRITICAL_ISR(&spinlock_);

    uint32_t now_ccount = get_cycle_count();
    if (last_clock_ccount != 0 && (now_ccount - last_clock_ccount) > FRAME_GAP_CYCLES) {
      // Detected frame gap — if we had a partial frame (bit_count != 0 and != 24), count it
      if (bit_count != 0 && bit_count != 24) {
        partial_frame_count++;
      }
      // Start a new frame
      shift_reg = 0;
      bit_count = 0;
      // Optional debug: keep ISR short
    }
    last_clock_ccount = now_ccount;

    // Record start and exit critical to minimize time interrupts are disabled
    uint32_t start_ccount = now_ccount;
    portEXIT_CRITICAL_ISR(&spinlock_);

    // Busy-wait using cycle count to let the data line settle (more accurate than counting NOPs)
    while ((get_cycle_count() - start_ccount) < SAMPLE_DELAY_CYCLES) {
      asm volatile ("nop");
    }

    // Re-enter critical briefly to sample DATA and update shared state
    portENTER_CRITICAL_ISR(&spinlock_);
    bool bit = gpio_get_level((gpio_num_t)DATA_PIN);

    shift_reg = (shift_reg << 1) | static_cast<uint32_t>(bit);
    bit_count++;

    if (bit_count == 24) {
      frame_ready = true;
      bit_count = 0;
    }

    portEXIT_CRITICAL_ISR(&spinlock_);
  }
};

}  // namespace esp32_spa_v2

// Plain C ISR wrapper placed in IRAM to avoid dangerous relocations when linking C++ static member wrappers.
extern "C" void IRAM_ATTR esp32_spa_v2_isr_wrapper(void* arg) {
  auto *self = static_cast<esp32_spa_v2::HotTubDisplaySensor*>(arg);
  if (self) self->handle_isr();
}