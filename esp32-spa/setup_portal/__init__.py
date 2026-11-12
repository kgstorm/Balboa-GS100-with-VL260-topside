import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import web_server_base
from esphome.components.web_server_base import CONF_WEB_SERVER_BASE_ID
from esphome.const import CONF_ID, PLATFORM_ESP32
from esphome.core import coroutine_with_priority
from esphome.coroutine import CoroPriority

# Reuses the stock captive portal (DNS hijack, AP lifecycle, WiFi save), so it
# must be present in the config. This component only replaces the page served
# and adds the unified WiFi + MQTT save endpoint.
DEPENDENCIES = ["wifi", "captive_portal"]

setup_portal_ns = cg.esphome_ns.namespace("setup_portal")
SpaSetupPortal = setup_portal_ns.class_("SpaSetupPortal", cg.Component)

# Only ESP32 is supported (matches the rest of this project).
CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(SpaSetupPortal),
            cv.GenerateID(CONF_WEB_SERVER_BASE_ID): cv.use_id(
                web_server_base.WebServerBase
            ),
        }
    ).extend(cv.COMPONENT_SCHEMA),
    cv.only_on([PLATFORM_ESP32]),
)


@coroutine_with_priority(CoroPriority.CAPTIVE_PORTAL)
async def to_code(config):
    paren = await cg.get_variable(config[CONF_WEB_SERVER_BASE_ID])
    var = cg.new_Pvariable(config[CONF_ID], paren)
    await cg.register_component(var, config)
    cg.add_define("USE_WEBSERVER_AUTH")
