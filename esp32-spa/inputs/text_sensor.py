import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import text_sensor

# Reference the C++ class from sensor.py
esp32_spa_ns = cg.esphome_ns.namespace('esp32_spa')
HotTubDisplaySensor = esp32_spa_ns.class_('HotTubDisplaySensor', cg.Component)

CONF_PARENT_ID = 'parent_id'

# This platform requires referencing an existing HotTubDisplaySensor instance
CONFIG_SCHEMA = text_sensor.text_sensor_schema().extend({
    cv.Required(CONF_PARENT_ID): cv.use_id(HotTubDisplaySensor),
    cv.Required('type'): cv.enum({'error_code': 'ERROR_CODE'}),
})


async def to_code(config):
    parent = await cg.get_variable(config[CONF_PARENT_ID])
    var = await text_sensor.new_text_sensor(config)
    
    sensor_type = config['type']
    if sensor_type == 'error_code':
        cg.add(parent.set_error_text_sensor(var))