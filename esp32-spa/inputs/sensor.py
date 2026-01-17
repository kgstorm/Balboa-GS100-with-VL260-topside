import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import sensor as sensor_ns
from esphome.const import CONF_ID
from esphome.cpp_types import Component

# Expose the C++ class `HotTubDisplaySensor` (defined in esp32-spa-v2.h)
esp32_spa_ns = cg.esphome_ns.namespace('esp32_spa_v2')
HotTubDisplaySensor = esp32_spa_ns.class_('HotTubDisplaySensor', Component)

CONF_MEASURED_TEMP = 'measured_temp'
CONF_SET_TEMP = 'set_temp'

# Two temperature sensors
CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(HotTubDisplaySensor),
    cv.Optional(CONF_MEASURED_TEMP): sensor_ns.sensor_schema(),
    cv.Optional(CONF_SET_TEMP): sensor_ns.sensor_schema(),
}).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    cg.add(var)

    if CONF_MEASURED_TEMP in config:
        sens = await sensor_ns.new_sensor(config[CONF_MEASURED_TEMP])
        cg.add(var.set_measured_temp_sensor(sens))
    
    if CONF_SET_TEMP in config:
        sens = await sensor_ns.new_sensor(config[CONF_SET_TEMP])
        cg.add(var.set_set_temp_sensor(sens))
