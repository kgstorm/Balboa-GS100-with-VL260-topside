import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import binary_sensor

# Reference the C++ class from sensor.py
esp32_spa_ns = cg.esphome_ns.namespace('esp32_spa')
HotTubDisplaySensor = esp32_spa_ns.class_('HotTubDisplaySensor', cg.Component)

CONF_PARENT_ID = 'parent_id'

# This platform requires referencing an existing HotTubDisplaySensor instance
CONFIG_SCHEMA = binary_sensor.binary_sensor_schema().extend({
    cv.Required(CONF_PARENT_ID): cv.use_id(HotTubDisplaySensor),
    cv.Required('type'): cv.enum({'heater': 'HEATER', 'pump': 'PUMP', 'light': 'LIGHT'}),
})


async def to_code(config):
    parent = await cg.get_variable(config[CONF_PARENT_ID])
    var = await binary_sensor.new_binary_sensor(config)
    
    sensor_type = config['type']
    if sensor_type == 'heater':
        cg.add(parent.set_heater_sensor(var))
    elif sensor_type == 'pump':
        cg.add(parent.set_pump_sensor(var))
    elif sensor_type == 'light':
        cg.add(parent.set_light_sensor(var))
