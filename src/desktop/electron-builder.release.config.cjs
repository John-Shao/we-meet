const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const { extends: base, ...release } = yaml.load(fs.readFileSync(path.join(__dirname, 'electron-builder.release.yml'), 'utf8'))
if (base !== './electron-builder.yml' || release.forceCodeSigning !== true) throw new Error('Invalid formal release signing policy')
module.exports = { ...require('./electron-builder.config.cjs'), ...release }
